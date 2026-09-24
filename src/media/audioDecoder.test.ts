import { describe, expect, it } from 'vitest'
import { AudioStreamDecoder, isHeAac, normalizeAudioCodec } from './audioDecoder'

describe('audio codec handling', () => {
  it('recognizes HE-AAC and HE-AACv2', () => {
    expect(isHeAac('mp4a.40.5')).toBe(true)
    expect(isHeAac('mp4a.40.29')).toBe(true)
    expect(isHeAac('mp4a.40.2')).toBe(false)
    expect(isHeAac('mp4a.40.2;codecs=x')).toBe(false)
  })

  it('normalizes the HE-AACv2 alias', () => {
    expect(normalizeAudioCodec('mp4a.40.29')).toBe('mp4a.40.5')
    expect(normalizeAudioCodec('mp4a.40.2')).toBe('mp4a.40.2')
  })
})

describe('AudioStreamDecoder', () => {
  it('is unsupported without WebCodecs or AudioContext', () => {
    const decoder = new AudioStreamDecoder()
    expect(decoder.supported).toBe(false)
    expect(decoder.anchored).toBe(false)
    expect(decoder.queued).toBe(0)
    expect(decoder.clockTime).toBe(0)
  })

  it('no-ops safely when WebCodecs is missing', () => {
    const decoder = new AudioStreamDecoder()
    decoder.configure({ codec: 'mp4a.40.5', sampleRate: 48000, numberOfChannels: 2 })
    expect(decoder.configured).toBe(true)
    expect(() => decoder.pushSample(Uint8Array.from([0xff, 0xf1]), 0)).not.toThrow()
    expect(() => decoder.setMuted(true)).not.toThrow()
    expect(() => decoder.setChannelMode('main')).not.toThrow()
    expect(() => decoder.setChannelMode('sub')).not.toThrow()
    expect(() => decoder.resume()).not.toThrow()
    expect(() => decoder.reset()).not.toThrow()
    expect(() => decoder.close()).not.toThrow()
    expect(decoder.configured).toBe(false)
  })
})
