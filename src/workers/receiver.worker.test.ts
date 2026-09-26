import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReceiverCommand, ReceiverEvent } from './protocol'

describe('receiver worker live input', () => {
  const events: ReceiverEvent[] = []
  let now = 0
  const context = {
    postMessage: (event: ReceiverEvent) => events.push(event),
    onmessage: null as ((event: { data: ReceiverCommand }) => void) | null,
  }
  const send = (data: ReceiverCommand) => context.onmessage!({ data })
  const init = (sampleRate: number, spectrumEnabled = true, webgpu = false) =>
    send({
      type: 'init',
      options: {
        source: { kind: 'rtlsdr', deviceLabel: 'FC0013' },
        frequency: 509_142_857,
        sampleRate,
        gainDb: 19.7,
        ppm: 0,
        spectrumEnabled,
        webgpu,
      },
    })
  const input = (sampleRate: number) =>
    send({
      type: 'iqChunk',
      chunk: {
        data: new Uint8Array(16384).fill(128).buffer,
        format: 'u8',
        sampleRate,
        centerFrequency: 509_142_857,
        sequence: 0,
        timestamp: now,
      },
    })

  beforeEach(async () => {
    vi.resetModules()
    events.length = 0
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('self', context)
    await import('./receiver.worker')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('publishes enabled spectrum and nonzero input rate while acquiring', () => {
    init(1_200_000)
    now = 600
    input(1_200_000)
    expect(events.some((event) => event.type === 'spectrum')).toBe(true)
    const stats = events.find((event) => event.type === 'stats')
    expect(stats?.type).toBe('stats')
    if (stats?.type !== 'stats') return
    expect(stats.stats.throughput.iqSamplesPerSecond).toBeCloseTo(8192 / 0.6)
    expect(stats.stats.buffer.bufferedSamples).toBeGreaterThan(0)
  })

  it('flushes the remaining decoder batch at the end of an IQ file', async () => {
    const { OneSegPipeline } = await import('../dsp/pipeline')
    const flush = vi.spyOn(OneSegPipeline.prototype, 'flush')
    send({
      type: 'init',
      options: {
        source: {
          kind: 'iq-file',
          data: new Uint8Array(2048).fill(128).buffer,
          metadata: {
            version: 1,
            format: 'u8',
            sampleRate: 1_200_000,
            centerFrequency: 509_142_857,
            gainDb: 19.7,
            ppm: 0,
            timestamp: '2026-09-24T00:00:00.000Z',
            device: 'RTL2832U',
            tuner: 'FC0013',
          },
        },
        frequency: 509_142_857,
        sampleRate: 1_200_000,
        gainDb: 19.7,
        ppm: 0,
      },
    })
    send({ type: 'start' })
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1))
  })

  it('falls back to the WASM front end when WebGPU is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    init(1_200_000, false, true)
    await vi.waitFor(() => {
      now = 600
      input(1_200_000)
      expect(events.some((event) => event.type === 'stats')).toBe(true)
    })
  })

  it('recreates the resampler when reconnecting with a different sample rate', () => {
    init(2_400_000)
    now = 600
    input(2_400_000)
    const first = events.find((event) => event.type === 'stats')
    init(1_200_000, false)
    events.length = 0
    now = 1200
    input(1_200_000)
    const second = events.find((event) => event.type === 'stats')
    expect(first?.type).toBe('stats')
    expect(second?.type).toBe('stats')
    if (first?.type !== 'stats' || second?.type !== 'stats') return
    expect(second.stats.buffer.bufferedSamples).toBeGreaterThan(
      first.stats.buffer.bufferedSamples * 1.9,
    )
    expect(events.some((event) => event.type === 'spectrum')).toBe(false)
  })
})
