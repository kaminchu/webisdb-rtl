import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AvcConfig } from '../models/media'
import {
  VideoStreamDecoder,
  annexBToAvcc,
  codecStringFromAvcConfig,
  hasAnnexBStartCode,
  isKeyframe,
  toVideoDecoderConfig,
} from './videoDecoder'

const avcConfig: AvcConfig = {
  configurationVersion: 1,
  avcProfileIndication: 0x42,
  profileCompatibility: 0xc0,
  avcLevelIndication: 0x15,
  description: Uint8Array.from([1, 0x42, 0xc0, 0x15]),
}

describe('codecStringFromAvcConfig', () => {
  it('builds an avc1.PPCCLL codec string', () => {
    expect(codecStringFromAvcConfig(avcConfig)).toBe('avc1.42C015')
  })
})

describe('toVideoDecoderConfig', () => {
  it('derives the codec and description from an AVC descriptor', () => {
    const config = toVideoDecoderConfig(avcConfig)
    expect(config.codec).toBe('avc1.42C015')
    expect(config.description).toBe(avcConfig.description)
  })

  it('passes through explicit options', () => {
    const description = Uint8Array.from([1, 2, 3])
    const config = toVideoDecoderConfig({
      codec: 'avc1.42E01E',
      description,
      codedWidth: 320,
      codedHeight: 240,
    })
    expect(config).toEqual({
      codec: 'avc1.42E01E',
      description,
      codedWidth: 320,
      codedHeight: 240,
    })
  })
})

describe('hasAnnexBStartCode', () => {
  it('detects three- and four-byte start codes', () => {
    expect(hasAnnexBStartCode(Uint8Array.from([0, 0, 1, 0x65]))).toBe(true)
    expect(hasAnnexBStartCode(Uint8Array.from([0, 0, 0, 1, 0x65]))).toBe(true)
    expect(hasAnnexBStartCode(Uint8Array.from([0, 0, 0, 2, 0x67]))).toBe(false)
  })
})

describe('annexBToAvcc', () => {
  it('converts start codes into four-byte length prefixes', () => {
    const data = Uint8Array.from([0, 0, 0, 1, 0x67, 0xaa, 0, 0, 1, 0x68, 0xbb, 0xcc])
    expect(Array.from(annexBToAvcc(data))).toEqual([
      0, 0, 0, 2, 0x67, 0xaa, 0, 0, 0, 3, 0x68, 0xbb, 0xcc,
    ])
  })

  it('trims trailing zero padding before the next start code', () => {
    const data = Uint8Array.from([0, 0, 1, 0x65, 0x80, 0x00, 0, 0, 0, 1, 0x41])
    expect(Array.from(annexBToAvcc(data))).toEqual([0, 0, 0, 2, 0x65, 0x80, 0, 0, 0, 1, 0x41])
  })

  it('leaves already length-prefixed data untouched', () => {
    const data = Uint8Array.from([0, 0, 0, 2, 0x67, 0xaa])
    expect(annexBToAvcc(data)).toBe(data)
  })
})

describe('isKeyframe', () => {
  it('detects IDR NAL units', () => {
    expect(isKeyframe(Uint8Array.from([0, 0, 0, 1, 0x65]))).toBe(true)
    expect(isKeyframe(Uint8Array.from([0, 0, 1, 0x41, 0, 0, 1, 0x65]))).toBe(true)
    expect(isKeyframe(Uint8Array.from([0, 0, 1, 0x41]))).toBe(false)
  })
})

describe('VideoStreamDecoder', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('stops recreating once the browser rejects the codec configuration', async () => {
    let configureCount = 0
    vi.stubGlobal(
      'VideoDecoder',
      class {
        private readonly handleError: (error: DOMException) => void
        constructor(init: VideoDecoderInit) {
          this.handleError = init.error
        }
        configure() {
          configureCount++
          const error = new DOMException('Unknown or ambiguous codec name.', 'NotSupportedError')
          queueMicrotask(() => this.handleError(error))
        }
        close() {}
      },
    )
    const errors: Error[] = []
    const decoder = new VideoStreamDecoder({
      onFrame: () => {},
      onError: (error) => errors.push(error),
    })
    decoder.configure({ codec: 'avc1.42E01E' })
    await Promise.resolve()
    expect(configureCount).toBe(1)
    expect(errors).toHaveLength(1)
    decoder.reset()
    await Promise.resolve()
    expect(configureCount).toBe(1)
    decoder.close()
  })

  it('is unsupported without WebCodecs', () => {
    const decoder = new VideoStreamDecoder({ onFrame: () => {} })
    expect(decoder.supported).toBe(false)
  })

  it('no-ops safely when WebCodecs is missing', () => {
    const decoder = new VideoStreamDecoder({ onFrame: () => {} })
    decoder.configure({ codec: 'avc1.42E01E' })
    expect(decoder.configured).toBe(true)
    expect(() => decoder.pushSample(Uint8Array.from([0, 0, 1, 0x65]), 0, true)).not.toThrow()
    expect(() => decoder.pushSample(Uint8Array.from([0, 0, 1, 0x41]), 0, false)).not.toThrow()
    expect(() => decoder.reset()).not.toThrow()
    expect(() => decoder.close()).not.toThrow()
    expect(decoder.configured).toBe(false)
  })
})
