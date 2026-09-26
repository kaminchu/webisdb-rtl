import { afterEach, describe, expect, it, vi } from 'vitest'
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

function setup(playbackTime?: () => number) {
  let output!: (data: AudioData) => void
  const callbacks: AudioDecoderInit[] = []
  const onError = vi.fn()
  vi.stubGlobal(
    'AudioDecoder',
    class {
      constructor(init: AudioDecoderInit) {
        callbacks.push(init)
        output = init.output
      }
      configure() {}
      close() {}
    },
  )
  const sources: {
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }[] = []
  const context = {
    currentTime: 0,
    state: 'running',
    createGain: () => ({ connect: vi.fn(), gain: { value: 1 } }),
    createBuffer: (_channels: number, frames: number) => ({
      getChannelData: () => new Float32Array(frames),
    }),
    createBufferSource: () => {
      const source = {
        connect: vi.fn(),
        addEventListener: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      }
      sources.push(source)
      return source
    },
  }
  const decoder = new AudioStreamDecoder({
    audioContext: context as unknown as AudioContext,
    playbackTime,
    onError,
  })
  decoder.configure({ codec: 'mp4a.40.2', sampleRate: 24_000, numberOfChannels: 1 })
  const emit = (timestamp: number, sampleRate = 24_000) => {
    const close = vi.fn()
    output({
      timestamp,
      numberOfChannels: 1,
      numberOfFrames: 1024,
      sampleRate,
      copyTo: vi.fn(),
      close,
    } as unknown as AudioData)
    expect(close).toHaveBeenCalledTimes(1)
  }
  return { decoder, context, sources, emit, callbacks, onError }
}

describe('audio scheduling', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('discards stale output and errors after reset and close', () => {
    const { decoder, sources, emit, callbacks, onError } = setup()
    const stale = callbacks[0]
    decoder.reset()
    const current = callbacks[1]
    const data = { close: vi.fn() } as unknown as AudioData
    stale.output(data)
    stale.error(new DOMException('Stale rejection', 'NotSupportedError'))
    expect(data.close).toHaveBeenCalledTimes(1)
    expect(sources).toHaveLength(0)
    expect(decoder.anchored).toBe(false)
    expect(callbacks).toHaveLength(2)
    expect(onError).not.toHaveBeenCalled()
    emit(0)
    expect(sources).toHaveLength(1)
    decoder.close()
    current.output(data)
    current.error(new DOMException('Stale failure', 'EncodingError'))
    expect(data.close).toHaveBeenCalledTimes(2)
    expect(sources).toHaveLength(1)
    expect(callbacks).toHaveLength(2)
    expect(onError).not.toHaveBeenCalled()
    expect(decoder.anchored).toBe(false)
  })

  it('uses the shared buffered PTS timeline for the first audio buffer', () => {
    const { decoder, sources, emit } = setup(() => 9.5)
    emit(10_000_000)
    expect(sources[0].start).toHaveBeenCalledWith(0.5, 0)
    expect(decoder.clockTime).toBe(9.5)
    decoder.close()
  })

  it('can queue more than 32 AAC buffers within the scheduling window', () => {
    const { decoder, sources, emit } = setup()
    for (let i = 0; i < 40; i++) emit(Math.round(((i * 1024) / 48_000) * 1_000_000), 48_000)
    expect(sources).toHaveLength(40)
    decoder.close()
  })

  it('drops expired audio and keeps surviving late buffers consecutive', () => {
    const { decoder, context, sources, emit } = setup()
    emit(0)
    context.currentTime = 0.2
    emit(42_667)
    emit(85_333)
    expect(sources).toHaveLength(1)
    emit(128_000)
    emit(170_667)
    expect(sources).toHaveLength(3)
    expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(0.25)
    expect(sources[2].start.mock.calls[0][0]).toBeCloseTo(0.292667)
    expect(decoder.clockTime).toBeCloseTo(0.078)
    decoder.close()
  })

  it('re-anchors on a large PTS jump instead of dropping audio forever', () => {
    const { decoder, sources, emit } = setup()
    emit(0)
    expect(sources).toHaveLength(1)
    // A dropout jumps the timeline past the scheduling window; without a
    // re-anchor every later buffer is rejected as "too far ahead".
    emit(5_000_000)
    expect(sources).toHaveLength(2)
    expect(sources[1].start).toHaveBeenCalledWith(0.05, 0)
    decoder.close()
  })

  it('clears scheduled audio and its clock on reset', () => {
    const { decoder, sources, emit } = setup()
    emit(0)
    decoder.reset()
    expect(sources[0].stop).toHaveBeenCalledTimes(1)
    expect(decoder.anchored).toBe(false)
    emit(10_000_000)
    expect(sources[1].start).toHaveBeenCalledWith(0.05, 0)
    decoder.close()
  })

  it('does not accumulate stale audio while autoplay is suspended', () => {
    let mediaTime = 10
    const { decoder, context, sources, emit } = setup(() => mediaTime)
    context.state = 'suspended'
    emit(10_000_000)
    expect(sources).toHaveLength(0)
    mediaTime = 15
    context.state = 'running'
    emit(15_000_000)
    expect(sources[0].start).toHaveBeenCalledWith(0.05, 0)
    expect(decoder.clockTime).toBeCloseTo(14.95)
    decoder.close()
  })
})

describe('AudioStreamDecoder', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('stops recreating once the browser rejects the codec configuration', async () => {
    let configureCount = 0
    vi.stubGlobal(
      'AudioDecoder',
      class {
        private readonly handleError: (error: DOMException) => void
        constructor(init: AudioDecoderInit) {
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
    const context = {
      currentTime: 0,
      state: 'running',
      createGain: () => ({ connect: vi.fn(), gain: { value: 1 } }),
    }
    const errors: Error[] = []
    const decoder = new AudioStreamDecoder({
      audioContext: context as unknown as AudioContext,
      onError: (error) => errors.push(error),
    })
    decoder.configure({ codec: 'mp4a.40.5', sampleRate: 48_000, numberOfChannels: 2 })
    await Promise.resolve()
    expect(configureCount).toBe(1)
    expect(errors).toHaveLength(1)
    decoder.reset()
    await Promise.resolve()
    expect(configureCount).toBe(1)
    decoder.close()
  })

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
