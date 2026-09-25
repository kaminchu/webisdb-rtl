import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PesPacket } from '../models/media'
import { TransportStream } from '../ts/TransportStream'
import { buildPes, buildPmt, pesToPackets, sectionToPackets } from '../ts/sectionBuilder'
import { OneSegPlayer } from './player'

function packet(kind: PesPacket['kind'], pts?: number): PesPacket {
  return {
    pid: 0x100,
    kind,
    streamId: 0xe0,
    data: Uint8Array.from([0, 0, 1, 0x41, 0x9a]),
    ...(pts !== undefined ? { pts } : {}),
  }
}

function createPlayer(): OneSegPlayer {
  return new OneSegPlayer(document.createElement('canvas'))
}

describe('OneSegPlayer routing', () => {
  it('counts video and audio packets and ignores captions/data', () => {
    const player = createPlayer()
    player.pushPes(packet('video', 90_000))
    player.pushPes(packet('video', 180_000))
    player.pushPes(packet('audio', 90_000))
    player.pushPes(packet('caption', 90_000))
    player.pushPes(packet('data', 90_000))
    const stats = player.stats
    expect(stats.videoSamples).toBe(2)
    expect(stats.audioSamples).toBe(1)
    expect(stats.videoFramesDecoded).toBe(0)
    expect(stats.audioBuffersQueued).toBe(0)
    expect(stats.dropped).toBe(0)
    player.close()
  })

  it('tracks the most recent media PTS', () => {
    const player = createPlayer()
    player.pushPes(packet('video', 1234))
    expect(player.stats.lastPts).toBe(1234)
    player.pushPes(packet('audio', 5678))
    expect(player.stats.lastPts).toBe(5678)
    player.pushPes(packet('caption', 9999))
    expect(player.stats.lastPts).toBe(5678)
    player.close()
  })

  it('ignores packets without a PTS for lastPts', () => {
    const player = createPlayer()
    player.pushPes(packet('video'))
    expect(player.stats.lastPts).toBeNull()
    player.close()
  })
})

describe('OneSegPlayer jitter buffer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('decodes ahead of the buffered presentation time', () => {
    vi.useFakeTimers()
    let now = 0
    const player = new OneSegPlayer(document.createElement('canvas'), {
      bufferSec: 3,
      clock: () => now,
    })

    player.pushPes(packet('video', 90_000))
    expect(player.stats.videoSamples).toBe(0)
    expect(player.stats.bufferedPes).toBe(1)

    now = 1.999
    vi.advanceTimersByTime(1_999)
    expect(player.stats.videoSamples).toBe(0)

    now = 2
    vi.advanceTimersByTime(100)
    expect(player.stats.videoSamples).toBe(1)
    expect(player.stats.bufferedPes).toBe(0)
    player.close()
  })

  it('absorbs arrival jitter using PTS rather than delaying every arrival', () => {
    vi.useFakeTimers()
    let now = 0
    const player = new OneSegPlayer(document.createElement('canvas'), {
      bufferSec: 3,
      clock: () => now,
    })
    player.pushPes(packet('video', 90_000))
    now = 2.8
    vi.advanceTimersByTime(2_800)
    player.pushPes(packet('video', 135_000))
    expect(player.stats.videoSamples).toBe(2)
    expect(player.stats.bufferedPes).toBe(0)
    player.close()
  })

  it('re-anchors immediately when the PTS jumps past the buffering window', () => {
    const player = new OneSegPlayer(document.createElement('canvas'), {
      bufferSec: 3,
      clock: () => 0,
    })
    player.pushPes(packet('video', 90_000))
    player.pushPes(packet('video', 900_000))
    const avSync = (player as unknown as { avSync: { anchoredPtsSec: number | null } }).avSync
    expect(avSync.anchoredPtsSec).toBeCloseTo(10)
    player.close()
  })

  it('drops queued packets and timers on reset', () => {
    vi.useFakeTimers()
    const player = new OneSegPlayer(document.createElement('canvas'), {
      bufferSec: 3,
      clock: () => 0,
    })
    player.pushPes(packet('audio', 90_000))
    expect(player.stats.bufferedPes).toBe(1)
    player.reset()
    expect(player.stats.bufferedPes).toBe(0)
    player.close()
  })

  it('does not mistake interleaved audio and video timestamps for a discontinuity', () => {
    const player = new OneSegPlayer(document.createElement('canvas'), { clock: () => 0 })
    const recover = vi.spyOn(player, 'recover')
    player.pushPes(packet('video', 900_000))
    player.pushPes(packet('audio', 630_000))
    player.pushPes(packet('video', 906_000))
    player.pushPes(packet('audio', 636_000))
    expect(recover).not.toHaveBeenCalled()
    player.close()
  })

  it('forgets the previous channel timeline on reset', () => {
    const player = new OneSegPlayer(document.createElement('canvas'), {
      bufferSec: 3,
      clock: () => 0,
    })
    player.pushPes(packet('video', 90_000))
    player.reset()
    const recover = vi.spyOn(player, 'recover')
    player.pushPes(packet('video', 900_000))
    expect(recover).not.toHaveBeenCalled()
    expect(player.stats.bufferedPes).toBe(1)
    player.close()
  })
})

describe('OneSegPlayer without WebCodecs', () => {
  it('is safe to drive and reset', () => {
    const player = createPlayer()
    expect(() => {
      player.pushPes(packet('video', 0))
      player.pushPes(packet('audio', 0))
      player.setMuted(true)
      player.reset()
      player.close()
    }).not.toThrow()
  })

  it('accepts explicit AVC and AAC configurations', () => {
    const player = createPlayer()
    expect(() => {
      player.configureVideo({
        configurationVersion: 1,
        avcProfileIndication: 0x42,
        profileCompatibility: 0xc0,
        avcLevelIndication: 0x15,
        description: Uint8Array.from([1, 0x42, 0xc0, 0x15]),
      })
      player.configureAudio({
        codec: 'mp4a.40.5',
        sampleRate: 48000,
        numberOfChannels: 2,
      })
      player.pushPes(packet('video', 90_000))
    }).not.toThrow()
    expect(player.stats.videoSamples).toBe(1)
    player.close()
  })

  it('returns an independent stats snapshot', () => {
    const player = createPlayer()
    const first = player.stats
    player.pushPes(packet('video', 1))
    expect(first.videoSamples).toBe(0)
    expect(player.stats.videoSamples).toBe(1)
    player.close()
  })
})

function setup(bufferSec = 0) {
  let output!: (frame: VideoFrame) => void
  vi.stubGlobal(
    'VideoDecoder',
    class {
      state = 'configured'
      constructor(init: VideoDecoderInit) {
        output = init.output
      }
      configure() {}
      close() {}
    },
  )
  let callback: FrameRequestCallback | null = null
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    callback = cb
    return 1
  })
  const cancel = vi.fn(() => {
    callback = null
  })
  vi.stubGlobal('cancelAnimationFrame', cancel)
  const canvas = document.createElement('canvas')
  const draw = vi.fn()
  const fillText = vi.fn()
  vi.spyOn(canvas, 'getContext').mockReturnValue({
    drawImage: draw,
    save: vi.fn(),
    restore: vi.fn(),
    strokeText: vi.fn(),
    fillText,
  } as unknown as CanvasRenderingContext2D)
  let now = 0
  const player = new OneSegPlayer(canvas, { clock: () => now, bufferSec })
  player.pushPes(packet('video', 90_000))
  const frames = Array.from(
    { length: 15 },
    (_, i) =>
      ({
        timestamp: 1_000_000 + Math.round((i * 1_000_000) / 15),
        displayWidth: 320,
        displayHeight: 180,
        close: vi.fn(),
      }) as unknown as VideoFrame,
  )
  return {
    player,
    draw,
    fillText,
    frames,
    cancel,
    emit: (frame: VideoFrame) => output(frame),
    tick: (time: number) => {
      now = time
      const cb = callback
      callback = null
      cb?.(time * 1000)
    },
  }
}

describe('OneSegPlayer frame presentation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([900_000, 2 ** 33 - 9_000])(
    'resumes rendering after the PTS moves backwards from %i',
    (previousPts) => {
      const { player, draw, frames, emit, tick } = setup()
      player.pushPes(packet('video', previousPts))
      player.pushPes(packet('video', 90_000))
      emit(frames[0])
      tick(0.001)
      expect(draw).toHaveBeenCalledTimes(1)
      expect(player.stats.dropped).toBe(0)
      player.close()
    },
  )

  it('recovers a stalled startup even before the first frame is drawn', () => {
    const { player, draw, frames, emit, tick } = setup()
    const recover = vi.spyOn(player, 'recover')
    tick(3)
    player.pushPes(packet('video', 96_000))
    expect(recover).toHaveBeenCalledTimes(1)
    emit({ ...frames[0], timestamp: 1_066_667 } as VideoFrame)
    tick(3.001)
    expect(draw).toHaveBeenCalledTimes(1)
    player.close()
  })

  it('detects incoming video stalled in the jitter queue without resetting during buffering', () => {
    const { player, tick } = setup(3)
    const recover = vi.spyOn(player, 'recover')
    tick(3)
    player.pushPes(packet('video', 180_000))
    expect(recover).not.toHaveBeenCalled()
    // A frozen master clock leaves incoming packets queued rather than routed.
    const sync = (player as unknown as { avSync: { now(): number } }).avSync
    vi.spyOn(sync, 'now').mockReturnValue(0)
    player.pushPes(packet('video', 270_000))
    expect(player.stats.bufferedPes).toBeGreaterThan(0)
    tick(6)
    player.pushPes(packet('video', 360_000))
    expect(recover).toHaveBeenCalledTimes(1)
    player.close()
  })

  it('draws a caption identified by the broadcast PMT descriptor over video', () => {
    const { player, fillText, frames, emit, tick } = setup()
    player.setSubtitlesEnabled(true)
    const stream = new TransportStream({ onPes: (pes) => player.pushPes(pes) })
    stream.push(
      sectionToPackets(
        buildPmt({
          programNumber: 32128,
          pcrPid: 1535,
          streams: [
            {
              pid: 1415,
              streamType: 0x06,
              // ARIB STD-B10: stream_identifier (0x52), data_component (0xfd).
              descriptors: [0x52, 1, 0x87, 0xfd, 3, 0, 0x12, 0xad],
            },
          ],
        }),
        0x1fc8,
      ),
    )
    const payload = Uint8Array.from([
      0x80, 0xff, 0xf0, 4, 0, 0, 0, 12, 0x3f, 0, 0, 8, 0x1f, 0x20, 0, 0, 3, 0x0c, 0xa4, 0xb3, 0, 0,
    ])
    stream.push(pesToPackets(1415, buildPes(0xbd, payload, { pts: 0 })))
    frames.slice(0, 1).forEach(emit)
    tick(0.001)
    expect(fillText).toHaveBeenCalledWith('こ', 9, 165)
    player.close()
  })

  it('presents a burst of 15 fps frames individually without dropping the oldest eight', () => {
    const { player, draw, frames, emit, tick } = setup()
    frames.forEach(emit)
    expect(draw).not.toHaveBeenCalled()
    for (let i = 0; i < frames.length; i++) {
      tick(i / 15 + 0.001)
      expect(draw).toHaveBeenCalledTimes(i + 1)
      expect(draw.mock.lastCall?.[0]).toBe(frames[i])
    }
    expect(player.stats.dropped).toBe(0)
    frames.forEach((frame) => expect(frame.close).toHaveBeenCalledTimes(1))
    player.close()
  })

  it('holds decoded frames until the configured presentation delay has elapsed', () => {
    const { player, draw, frames, emit, tick } = setup(3)
    player.configureVideo({ codec: 'avc1.42E01E' })
    frames.forEach(emit)
    tick(2.99)
    expect(draw).not.toHaveBeenCalled()
    tick(3.001)
    expect(draw).toHaveBeenCalledTimes(1)
    expect(draw.mock.lastCall?.[0]).toBe(frames[0])
    player.close()
  })

  it('draws only the newest due frame after a delayed animation callback', () => {
    const { player, draw, frames, emit, tick } = setup()
    frames.forEach(emit)
    tick(0.201)
    expect(draw).toHaveBeenCalledTimes(1)
    expect(draw.mock.lastCall?.[0]).toBe(frames[3])
    expect(player.stats.dropped).toBe(3)
    player.close()
    frames.forEach((frame) => expect(frame.close).toHaveBeenCalledTimes(1))
  })

  it('cancels pending rendering and closes every frame on reset', () => {
    const { player, draw, frames, emit, tick, cancel } = setup()
    frames.forEach(emit)
    player.reset()
    expect(cancel).toHaveBeenCalledTimes(1)
    tick(1)
    expect(draw).not.toHaveBeenCalled()
    frames.forEach((frame) => expect(frame.close).toHaveBeenCalledTimes(1))
    player.close()
  })
})
