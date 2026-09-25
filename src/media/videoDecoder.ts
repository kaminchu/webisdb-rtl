import type { AvcConfig } from '../models/media'

export interface VideoDecoderConfigInput {
  codec: string
  description?: Uint8Array
  codedWidth?: number
  codedHeight?: number
}

export interface VideoStreamDecoderOptions {
  onFrame: (frame: VideoFrame) => void
  onError?: (error: Error) => void
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase()
}

/**
 * True when a VideoDecoder error means the configuration itself was rejected
 * (unsupported/unknown codec). Such errors arrive through the async error
 * callback in some browsers and would otherwise trigger an endless
 * reconfigure/error loop.
 */
function isConfigError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : undefined
  return name === 'NotSupportedError' || name === 'TypeError'
}

/** Build an RFC 6381 `avc1.PPCCLL` codec string from an AVC descriptor. */
export function codecStringFromAvcConfig(config: AvcConfig): string {
  return `avc1.${hexByte(config.avcProfileIndication)}${hexByte(
    config.profileCompatibility,
  )}${hexByte(config.avcLevelIndication)}`
}

export function toVideoDecoderConfig(
  config: AvcConfig | VideoDecoderConfigInput,
): VideoDecoderConfig {
  if ('avcProfileIndication' in config) {
    return { codec: codecStringFromAvcConfig(config), description: config.description }
  }
  const result: VideoDecoderConfig = { codec: config.codec }
  if (config.description) result.description = config.description
  if (config.codedWidth) result.codedWidth = config.codedWidth
  if (config.codedHeight) result.codedHeight = config.codedHeight
  return result
}

export function hasAnnexBStartCode(data: Uint8Array): boolean {
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) return true
  }
  return false
}

/**
 * Convert an Annex-B byte stream into AVCC (4-byte big-endian length prefixes).
 * A buffer without start codes is returned unchanged, so already-AVCC samples
 * pass through. The AVCDecoderConfigurationRecord produced by the demuxer uses
 * `lengthSizeMinusOne = 3`, matching the 4-byte prefixes written here.
 */
export function annexBToAvcc(data: Uint8Array): Uint8Array {
  const starts: number[] = []
  let i = 0
  while (i + 3 <= data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i)
      i += 3
    } else {
      i++
    }
  }
  if (starts.length === 0) return data

  const parts: Uint8Array[] = []
  let total = 0
  for (let s = 0; s < starts.length; s++) {
    const begin = starts[s] + 3
    let end = s + 1 < starts.length ? starts[s + 1] : data.length
    while (end > begin && data[end - 1] === 0) end--
    if (end <= begin) continue
    const length = end - begin
    const part = new Uint8Array(4 + length)
    part[0] = (length >>> 24) & 0xff
    part[1] = (length >>> 16) & 0xff
    part[2] = (length >>> 8) & 0xff
    part[3] = length & 0xff
    part.set(data.subarray(begin, end), 4)
    parts.push(part)
    total += part.length
  }
  if (parts.length === 0) return data

  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

/** True when an Annex-B access unit contains an IDR (NAL type 5) slice. */
export function isKeyframe(data: Uint8Array): boolean {
  let i = 0
  while (i + 4 <= data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if ((data[i + 3] & 0x1f) === 5) return true
      i += 4
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
      if (i + 4 < data.length && (data[i + 4] & 0x1f) === 5) return true
      i += 5
    } else {
      i++
    }
  }
  return false
}

/**
 * Thin wrapper over WebCodecs `VideoDecoder`. When WebCodecs is unavailable
 * every method is a safe no-op and `supported` is false. Frames are handed to
 * `onFrame`; the caller owns and must close them.
 */
export class VideoStreamDecoder {
  private readonly onFrame: (frame: VideoFrame) => void
  private readonly onError: ((error: Error) => void) | undefined
  private decoder: VideoDecoder | null = null
  private config: VideoDecoderConfig | null = null
  private configRejected = false
  private avcc = false
  private needsKey = true

  constructor(options: VideoStreamDecoderOptions) {
    this.onFrame = options.onFrame
    this.onError = options.onError
  }

  get supported(): boolean {
    return typeof VideoDecoder !== 'undefined'
  }

  get configured(): boolean {
    return this.config !== null
  }

  configure(config: AvcConfig | VideoDecoderConfigInput): void {
    this.config = toVideoDecoderConfig(config)
    this.avcc = this.config.description !== undefined
    this.needsKey = true
    this.configRejected = false
    if (!this.supported) return
    this.recreate()
  }

  pushSample(data: Uint8Array, ptsUs: number, isKey: boolean): void {
    if (!this.supported || !this.decoder || !this.config) return
    if (this.decoder.state !== 'configured') return
    if (this.needsKey && !isKey) return
    const chunkData = this.avcc ? annexBToAvcc(data) : data
    try {
      this.decoder.decode(
        new EncodedVideoChunk({
          type: isKey ? 'key' : 'delta',
          timestamp: ptsUs,
          data: chunkData,
        }),
      )
      this.needsKey = false
    } catch (error) {
      this.handleError(error)
    }
  }

  /** Flush and re-key, keeping the current configuration (LIVE recovery). */
  reset(): void {
    this.needsKey = true
    if (!this.supported || !this.config) return
    this.recreate()
  }

  close(): void {
    this.closeDecoder()
    this.config = null
    this.configRejected = false
  }

  private recreate(): boolean {
    this.closeDecoder()
    if (!this.supported || !this.config || this.configRejected) return false
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => this.emitFrame(frame),
        error: (error) => this.handleError(error),
      })
      this.decoder.configure(this.config)
      return true
    } catch (error) {
      // A rejected configuration is permanent: retrying it forever would spin.
      this.decoder = null
      if (isConfigError(error)) this.configRejected = true
      this.reportError(error)
      return false
    }
  }

  private emitFrame(frame: VideoFrame): void {
    try {
      this.onFrame(frame)
    } catch (error) {
      frame.close()
      this.reportError(error)
    }
  }

  private handleError(error: unknown): void {
    this.reportError(error)
    this.needsKey = true
    if (isConfigError(error)) {
      // The codec/description is rejected for good; recreating the decoder
      // would immediately fail again and flood the log.
      this.configRejected = true
      this.closeDecoder()
      return
    }
    if (this.supported && this.config && !this.configRejected) this.recreate()
  }

  private reportError(error: unknown): void {
    this.onError?.(error instanceof Error ? error : new Error(String(error)))
  }

  private closeDecoder(): void {
    const decoder = this.decoder
    this.decoder = null
    if (!decoder) return
    try {
      decoder.close()
    } catch {
      /* already closed */
    }
  }
}
