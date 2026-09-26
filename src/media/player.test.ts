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

  it('waits for actual media beyond the stall window, then decodes ahead without extra delay', () => {
    vi.useFakeTimers()
    let now = 0
    const player = new OneSegPlayer(document.createElement('canvas'), {
      bufferSec: 3,
      clock: () => now,
    })

    player.pushPes(packet('video', 90_000))
    expect(player.stats.videoSamples).toBe(0)
    expect(player.stats.bufferedPes).toBe(1)

    now = 10
    vi.advanceTimersByTime(10_000)
    player.pushPes(packet('video', 180_000))
    player.pushPes(packet('caption', 900_000))
    player.pushPes(packet('audio'))
    expect(player.stats.videoSamples).toBe(0)
    player.pushPes(packet('video', 270_000))
    expect(player.stats.videoSamples).toBe(0)
    player.pushPes(packet('video', 360_000))
    expect(player.stats.videoSamples).toBe(2)
    const sync = (player as unknown as { avSync: { now(): number } }).avSync
    expect(sync.now()).toBe(1)
    player.close()
  })

  it('requires a fresh full buffer after exhaustion even when a resumed burst advances PTS', () => {
    vi.useFakeTimers()
    let now = 0
    const player = new OneSegPlayer(document.createElement('canvas'), {
      bufferSec: 1,
      clock: () => now,
    })
    player.pushPes(packet('video', 90_000))
    player.pushPes(packet('video', 180_000))
    expect(player.stats.videoSamples).toBe(2)
    now = 3
    player.pushPes(packet('video', 270_000))
    player.pushPes(packet('video', 315_000))
    expect(player.stats.videoSamples).toBe(2)
    player.pushPes(packet('video', 360_000))
    expect(player.stats.videoSamples).toBe(5)
    now = 6
    vi.advanceTimersByTime(3_000)
    expect(vi.getTimerCount()).toBe(0)
    player.pushPes(packet('video', 405_000))
    expect(player.stats.videoSamples).toBe(5)
    player.close()
  })

  it('requires the configured span after a PTS jump and explicit recovery', () => {
    const player = new OneSegPlayer(document.createElement('canvas'), {
      bufferSec: 3,
      clock: () => 0,
    })
    player.pushPes(packet('video', 90_000))
    player.pushPes(packet('video', 900_000))
    const avSync = (player as unknown as { avSync: { anchoredPtsSec: number | null } }).avSync
    expect(avSync.anchoredPtsSec).toBeNull()
    for (const pts of [990_000, 1_080_000, 1_170_000]) player.pushPes(packet('video', pts))
    expect(avSync.anchoredPtsSec).toBe(10)
    player.recover()
    player.pushPes(packet('video', 1_260_000))
    expect(avSync.anchoredPtsSec).toBeNull()
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
    expect(vi.getTimerCount()).toBe(0)
    player.close()
  })

  it('uses only retained timestamps when the bounded buffer evicts media', () => {
    const player = new OneSegPlayer(document.createElement('canvas'), { bufferSec: 1 })
    player.pushPes(packet('video', 90_000))
    for (let i = 0; i < 1024; i++) player.pushPes(packet('caption', 90_000))
    player.pushPes(packet('video', 180_000))
    expect(player.stats.bufferedPes).toBe(1024)
    expect(player.stats.videoSamples).toBe(0)
    player.pushPes(packet('video', 270_000))
    expect(player.stats.videoSamples).toBe(2)
    player.close()
  })

  it('keeps zero-buffer startup and recovery immediate', () => {
    let now = 0
    const player = new OneSegPlayer(document.createElement('canvas'), { clock: () => now })
    player.pushPes(packet('audio', 90_000))
    expect(player.stats.audioSamples).toBe(1)
    now = 5
    player.pushPes(packet('audio', 180_000))
    expect(player.stats.audioSamples).toBe(2)
    player.recover()
    player.pushPes(packet('audio', 270_000))
    expect(player.stats.audioSamples).toBe(3)
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

function setup(bufferSec = 0, initialPts: number | null = 90_000) {
  let output!: (frame: VideoFrame) => void
  let error!: (error: DOMException) => void
  vi.stubGlobal(
    'VideoDecoder',
    class {
      state = 'configured'
      constructor(init: VideoDecoderInit) {
        output = init.output
        error = init.error
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
  player.pushPes(packet('video', initialPts ?? undefined))
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
    getOutput: () => output,
    fail: () => error(new DOMException('Rejected codec', 'NotSupportedError')),
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
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('anchors decoded untimestamped video immediately with zero buffering, including after recovery', () => {
    const { player, frames, emit, draw, tick } = setup(0, null)
    emit(frames[0])
    tick(0.001)
    expect(draw).toHaveBeenLastCalledWith(frames[0], 0, 0, 320, 180)
    player.recover()
    player.pushPes(packet('video'))
    emit(frames[1])
    tick(0.002)
    expect(draw).toHaveBeenCalledTimes(2)
    expect(draw).toHaveBeenLastCalledWith(frames[1], 0, 0, 320, 180)
    player.reset()
    player.pushPes(packet('video'))
    emit(frames[2])
    tick(0.003)
    expect(draw).toHaveBeenCalledTimes(3)
    player.close()
  })

  it('defers decoder error recovery, clears frames, and waits for a fresh span without retry loops', () => {
    vi.useFakeTimers()
    const { player, frames, emit, fail, getOutput } = setup(1)
    player.pushPes(packet('video', 180_000))
    const staleOutput = getOutput()
    emit(frames[0])
    const recover = vi.spyOn(player, 'recover')
    fail()
    expect(recover).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(frames[0].close).toHaveBeenCalledTimes(1)
    player.pushPes(packet('video', 270_000))
    expect(player.stats.videoSamples).toBe(2)
    vi.advanceTimersByTime(10_000)
    expect(recover).toHaveBeenCalledTimes(1)
    player.pushPes(packet('video', 360_000))
    expect(player.stats.videoSamples).toBe(4)
    staleOutput(frames[1])
    expect(frames[1].close).toHaveBeenCalledTimes(1)
    player.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('discards stale decoder output after reset and close', () => {
    const { player, frames, getOutput, draw, tick } = setup()
    const staleOutput = getOutput()
    player.reset()
    player.pushPes(packet('video', 90_000))
    staleOutput(frames[0])
    const output = getOutput()
    player.close()
    output(frames[1])
    tick(0.01)
    expect(draw).not.toHaveBeenCalled()
    expect(frames[0].close).toHaveBeenCalledTimes(1)
    expect(frames[1].close).toHaveBeenCalledTimes(1)
  })

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
    expect(recover).not.toHaveBeenCalled()
    tick(9)
    player.pushPes(packet('video', 450_000))
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

  it('rejects frames while buffering and presents immediately once enough media is retained', () => {
    const { player, draw, frames, emit, tick } = setup(3)
    player.configureVideo({ codec: 'avc1.42E01E' })
    emit(frames[1])
    tick(2.99)
    expect(draw).not.toHaveBeenCalled()
    expect(frames[1].close).toHaveBeenCalledTimes(1)
    for (const pts of [180_000, 270_000, 360_000]) player.pushPes(packet('video', pts))
    emit(frames[0])
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
