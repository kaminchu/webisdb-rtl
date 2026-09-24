export interface AudioDecoderConfigInput {
  codec: string
  sampleRate: number
  numberOfChannels: number
  description?: Uint8Array
}

export interface AudioStreamDecoderOptions {
  audioContext?: AudioContext
  onError?: (error: Error) => void
  /** Called each time a decoded buffer is scheduled for playback. */
  onBufferQueued?: () => void
  /** Maximum scheduling look-ahead in seconds; later buffers are dropped. */
  maxQueueSec?: number
}

const LEAD_SEC = 0.05
const DEFAULT_MAX_QUEUE_SEC = 1
const DEFAULT_MAX_QUEUE_LENGTH = 32

/** HE-AAC / HE-AACv2 (SBR / PS) codec strings used by one-seg audio. */
export function isHeAac(codec: string): boolean {
  const normalized = codec.toLowerCase()
  return normalized.startsWith('mp4a.40.5') || normalized.startsWith('mp4a.40.29')
}

/** Collapse the HE-AACv2 alias to the HE-AAC codec string WebCodecs expects. */
export function normalizeAudioCodec(codec: string): string {
  return codec.toLowerCase().startsWith('mp4a.40.29') ? 'mp4a.40.5' : codec
}

/**
 * Thin wrapper over WebCodecs `AudioDecoder` that schedules decoded
 * `AudioData` on an `AudioContext` gain node. When WebCodecs or AudioContext is
 * unavailable every method is a safe no-op and `supported` is false.
 */
export class AudioStreamDecoder {
  private readonly context: AudioContext | null
  private readonly gain: GainNode | null
  private readonly ownedContext: boolean
  private readonly onError: ((error: Error) => void) | undefined
  private readonly onBufferQueued: (() => void) | undefined
  private readonly maxQueueSec: number
  private readonly queue: AudioBufferSourceNode[] = []
  private decoder: AudioDecoder | null = null
  private config: AudioDecoderConfig | null = null
  private baseContextTime: number | null = null
  private basePtsSec: number | null = null

  constructor(options: AudioStreamDecoderOptions = {}) {
    this.onError = options.onError
    this.onBufferQueued = options.onBufferQueued
    this.maxQueueSec = options.maxQueueSec ?? DEFAULT_MAX_QUEUE_SEC
    let context = options.audioContext ?? null
    let owned = false
    if (!context && typeof AudioContext !== 'undefined') {
      context = new AudioContext()
      owned = true
    }
    this.context = context
    this.ownedContext = owned
    if (context) {
      const gain = context.createGain()
      gain.connect(context.destination)
      this.gain = gain
    } else {
      this.gain = null
    }
  }

  get supported(): boolean {
    return typeof AudioDecoder !== 'undefined' && this.context !== null
  }

  get configured(): boolean {
    return this.config !== null
  }

  /** True once the first decoded buffer has been anchored to the audio clock. */
  get anchored(): boolean {
    return this.baseContextTime !== null && this.basePtsSec !== null
  }

  /** Current media time in seconds derived from the AudioContext clock. */
  get clockTime(): number {
    const context = this.context
    if (!context) return 0
    if (this.baseContextTime === null || this.basePtsSec === null) return context.currentTime
    return this.basePtsSec + (context.currentTime - this.baseContextTime)
  }

  get queued(): number {
    return this.queue.length
  }

  configure(config: AudioDecoderConfigInput): void {
    const result: AudioDecoderConfig = {
      codec: normalizeAudioCodec(config.codec),
      sampleRate: config.sampleRate,
      numberOfChannels: config.numberOfChannels,
    }
    if (config.description) result.description = config.description
    this.config = result
    if (!this.supported) return
    this.recreate()
  }

  pushSample(data: Uint8Array, ptsUs: number): void {
    if (!this.supported || !this.decoder || !this.config) return
    if (this.decoder.state !== 'configured') return
    try {
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: ptsUs, data }))
    } catch (error) {
      this.handleError(error)
    }
  }

  setMuted(muted: boolean): void {
    if (this.gain) this.gain.gain.value = muted ? 0 : 1
  }

  resume(): void {
    if (this.context && this.context.state === 'suspended') void this.context.resume()
  }

  /** Flush queued buffers and re-key, keeping the current configuration. */
  reset(): void {
    this.stopQueued()
    this.baseContextTime = null
    this.basePtsSec = null
    if (!this.supported || !this.config) return
    this.recreate()
  }

  close(): void {
    this.stopQueued()
    this.closeDecoder()
    this.config = null
    this.baseContextTime = null
    this.basePtsSec = null
    if (this.ownedContext && this.context) void this.context.close()
  }

  private recreate(): void {
    this.closeDecoder()
    if (!this.supported || !this.config) return
    try {
      this.decoder = new AudioDecoder({
        output: (data) => this.onAudioData(data),
        error: (error) => this.handleError(error),
      })
      this.decoder.configure(this.config)
    } catch (error) {
      this.handleError(error)
    }
  }

  private onAudioData(data: AudioData): void {
    try {
      this.schedule(data)
    } catch (error) {
      this.reportError(error)
    } finally {
      data.close()
    }
  }

  private schedule(data: AudioData): void {
    const context = this.context
    const gain = this.gain
    if (!context || !gain) return
    const channels = data.numberOfChannels
    const frames = data.numberOfFrames
    if (channels <= 0 || frames <= 0) return

    const buffer = context.createBuffer(channels, frames, data.sampleRate)
    for (let channel = 0; channel < channels; channel++) {
      data.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: 'f32-planar' })
    }

    const ptsSec = data.timestamp / 1_000_000
    if (this.baseContextTime === null || this.basePtsSec === null) {
      this.baseContextTime = context.currentTime + LEAD_SEC
      this.basePtsSec = ptsSec
    }
    const now = context.currentTime
    let when = this.baseContextTime + (ptsSec - this.basePtsSec)
    if (when < now) when = now
    if (when > now + this.maxQueueSec || this.queue.length >= DEFAULT_MAX_QUEUE_LENGTH) return

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    source.addEventListener(
      'ended',
      () => {
        const index = this.queue.indexOf(source)
        if (index >= 0) this.queue.splice(index, 1)
      },
      { once: true },
    )
    source.start(when)
    this.queue.push(source)
    this.onBufferQueued?.()
  }

  private stopQueued(): void {
    for (const source of this.queue) {
      try {
        source.stop()
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    this.queue.length = 0
  }

  private handleError(error: unknown): void {
    this.reportError(error)
    if (this.supported && this.config) this.recreate()
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
