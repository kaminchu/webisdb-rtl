import { describe, expect, it } from 'vitest'
import type { PesPacket } from '../models/media'
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
