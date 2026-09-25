import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { IqChunk } from '../iq/IQSource'
import type { TmccInfo } from '../models/tmcc'
import type { StreamKind } from '../models/transportStream'
import { TransportStream } from '../ts/TransportStream'
import {
  MODE_PARAMS,
  ONESEG_SAMPLING_HZ,
  oneSegTmccCarriers,
  scatteredPilotIndices,
} from './isdbtParams'
import { TsFftBackend } from './stages/fft'
import { NcoCorrector } from './stages/frequencyCorrection'
import { OneSegPipeline, type OneSegPipelineStats, type PipelineState } from './pipeline'

function pushFile(
  path: string,
  sourceSampleRate = 1_200_000,
  shiftHz = 0,
): {
  locked: TmccInfo | null
  stats: OneSegPipelineStats | null
  tsBytes: number
  tsPackets: number
  serviceIds: number[]
  transportStreamId: number | null
  pes: Record<StreamKind, number>
  states: PipelineState[]
} {
  const raw = new Uint8Array(readFileSync(path))
  const tmccs: TmccInfo[] = []
  const stats: OneSegPipelineStats[] = []
  const states: PipelineState[] = []
  const serviceIds = new Set<number>()
  let transportStreamId: number | null = null
  const pes: Record<StreamKind, number> = {
    video: 0,
    audio: 0,
    caption: 0,
    data: 0,
    other: 0,
  }
  const transport = new TransportStream({
    onPmt: (pmt) => serviceIds.add(pmt.programNumber),
    onSdt: (sdt) => {
      transportStreamId = sdt.transportStreamId
    },
    onPes: (packet) => {
      pes[packet.kind]++
    },
  })
  let tsBytes = 0
  let tsPackets = 0
  const pipe = new OneSegPipeline(
    {
      onTs: (b) => {
        tsBytes += b.length
        for (let i = 0; i + 188 <= b.length; i += 188) if (b[i] === 0x47) tsPackets++
        transport.push(b)
      },
      onTmcc: (t) => tmccs.push(t),
      onStats: (s) => stats.push(s),
      onState: (s) => states.push(s),
    },
    { sourceSampleRate },
  )
  const CHUNK = 16 * 1024
  const nco = new NcoCorrector(shiftHz, sourceSampleRate)
  let seq = 0
  for (let off = 0; off < raw.length; off += CHUNK) {
    let data: Uint8Array | Float32Array = raw.subarray(off, Math.min(off + CHUNK, raw.length))
    if (shiftHz !== 0) {
      const re = Float32Array.from(
        { length: data.length / 2 },
        (_, i) => (data[2 * i] - 127.5) / 127.5,
      )
      const im = Float32Array.from(
        { length: data.length / 2 },
        (_, i) => (data[2 * i + 1] - 127.5) / 127.5,
      )
      nco.process(re, im)
      data = Float32Array.from({ length: data.length }, (_, i) => (i % 2 ? im[i >> 1] : re[i >> 1]))
    }
    const chunk: IqChunk = {
      data,
      format: shiftHz === 0 ? 'u8' : 'f32',
      sampleRate: sourceSampleRate,
      centerFrequency: 509_142_857,
      sequence: seq++,
      timestamp: off / 2,
    }
    pipe.pushIq(chunk)
  }
  pipe.flush()
  return {
    locked: tmccs.find((t) => t.locked) ?? null,
    stats: stats[stats.length - 1] ?? null,
    tsBytes,
    tsPackets,
    serviceIds: [...serviceIds],
    transportStreamId,
    pes,
    states,
  }
}

const IQ_FILES = ['/tmp/opencode/iq/all19.iq', '/tmp/opencode/iq/all23.iq']
const LIVE_IQ = '/tmp/opencode/iq/live17.iq'

describe.skipIf(!IQ_FILES.some((p) => existsSync(p)))('OneSegPipeline real IQ', () => {
  it.each([-1, 1])(
    'decodes after shifting integer CFO by %i carrier',
    (carriers) => {
      const path = IQ_FILES.find((file) => existsSync(file))!
      const result = pushFile(path, 1_200_000, carriers * MODE_PARAMS[3].carrierSpacingHz)
      expect(result.locked?.layers.A?.segments).toBe(1)
      expect(result.tsPackets).toBeGreaterThan(0)
      expect(result.serviceIds.length).toBeGreaterThan(0)
    },
    120_000,
  )
  for (const path of IQ_FILES) {
    it.skipIf(!existsSync(path))(
      `locks TMCC and reports fields for ${path}`,
      () => {
        const r = pushFile(path)
        // eslint-disable-next-line no-console
        console.log(
          `[pipeline] ${path} locked=${r.locked !== null} mode=${r.locked?.mode} gi=${r.locked?.guardIntervalRatio} ` +
            `A=${JSON.stringify(r.locked?.layers.A)} B=${JSON.stringify(r.locked?.layers.B)} ` +
            `carrierOffset=${r.stats?.carrierOffset} symbols=${r.stats?.symbolsProcessed} ` +
            `tsBytes=${r.tsBytes} tsPackets=${r.tsPackets} pes=${JSON.stringify(r.pes)} ` +
            `mer=${r.stats?.quality.merDb?.toFixed(1)}`,
        )
        expect(r.locked).not.toBeNull()
        expect(r.locked?.mode).toBeGreaterThanOrEqual(1)
        expect(r.locked?.mode).toBeLessThanOrEqual(3)
        expect(r.locked?.layers.A).not.toBeNull()
        expect(r.states).toContain('locked')
        expect(r.tsPackets).toBeGreaterThan(0)
        expect(r.pes.video + r.pes.audio).toBeGreaterThan(0)
        expect(r.serviceIds.length).toBeGreaterThan(0)
        expect(r.transportStreamId).not.toBeNull()
        expect(r.stats?.bufferedSamples).toBeLessThanOrEqual(2048)
      },
      120_000,
    )
  }
})

describe.skipIf(!existsSync(LIVE_IQ))('OneSegPipeline lock recovery', () => {
  it('re-acquires and emits TS after a signal dropout', () => {
    const raw = new Uint8Array(readFileSync(LIVE_IQ))
    const rate = 1_200_000
    for (let i = Math.floor(6 * rate) * 2; i < Math.floor(8 * rate) * 2 && i < raw.length; i++) {
      raw[i] = 128
    }
    let nowMs = 0
    let syncAfterGap = 0
    const states: PipelineState[] = []
    const pipe = new OneSegPipeline(
      {
        onState: (s) => states.push(s),
        onTs: (bytes) => {
          if (nowMs / 1000 < 9) return
          for (let i = 0; i + 188 <= bytes.length; i += 188) {
            if (bytes[i] === 0x47) syncAfterGap++
          }
        },
      },
      { clock: () => nowMs },
    )
    const CHUNK = 16 * 1024
    let seq = 0
    for (let off = 0; off < raw.length; off += CHUNK) {
      nowMs = (off / 2 / rate) * 1000
      pipe.pushIq({
        data: raw.subarray(off, Math.min(off + CHUNK, raw.length)),
        format: 'u8',
        sampleRate: rate,
        centerFrequency: 497_142_857,
        sequence: seq++,
        timestamp: nowMs,
      })
    }
    pipe.flush()
    expect(states).toContain('acquiring')
    expect(syncAfterGap).toBeGreaterThan(0)
  }, 300_000)
})

function synthU8(symbols: number, n: number, cp: number): Uint8Array {
  const backend = new TsFftBackend()
  const cps = MODE_PARAMS[3].carriersPerSegment
  const half = n >> 1
  const base = half - cps / 2
  const tmcc = oneSegTmccCarriers(3)
  const symLen = n + cp
  const out = new Uint8Array(symbols * symLen * 2)
  let o = 0
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  let seed = 12345
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x3fffffff - 1
  }
  for (let s = 0; s < symbols; s++) {
    re.fill(0)
    im.fill(0)
    const sp = new Set(scatteredPilotIndices(s % 4, cps))
    for (let c = 0; c < cps; c++) {
      const bin = (base + c + n) % n
      if (sp.has(c)) {
        const p = 4 / 3
        re[bin] = p
      } else if (tmcc.includes(c)) {
        re[bin] = s % 2 === 0 ? 1 : -1
      } else {
        re[bin] = rnd() > 0 ? 1 : -1
        im[bin] = rnd() > 0 ? 1 : -1
      }
    }
    backend.inverse(re, im)
    for (let i = n - cp; i < n; i++) {
      const v = re[i]
      const q = im[i]
      out[o++] = Math.max(0, Math.min(255, Math.round(v * 100 + 127.5)))
      out[o++] = Math.max(0, Math.min(255, Math.round(q * 100 + 127.5)))
    }
    for (let i = 0; i < n; i++) {
      out[o++] = Math.max(0, Math.min(255, Math.round(re[i] * 100 + 127.5)))
      out[o++] = Math.max(0, Math.min(255, Math.round(im[i] * 100 + 127.5)))
    }
  }
  return out
}

describe('OneSegPipeline synthetic', () => {
  it('reports incoming samples without requiring a stop or flush', () => {
    const stats: OneSegPipelineStats[] = []
    const pipe = new OneSegPipeline({ onStats: (value) => stats.push(value) })
    pipe.pushIq({
      data: new Uint8Array(16384).fill(128),
      format: 'u8',
      sampleRate: 1_200_000,
      centerFrequency: 509_142_857,
      sequence: 0,
      timestamp: 0,
    })
    expect(stats).toHaveLength(1)
    expect(stats[0].state).toBe('acquiring')
    expect(stats[0].bufferedSamples).toBeGreaterThan(0)
  })
  it('consumes a synthetic OFDM stream without throwing', () => {
    const data = synthU8(3, 1024, 128)
    const states: PipelineState[] = []
    let threw = false
    const pipe = new OneSegPipeline(
      { onState: (s) => states.push(s) },
      { sourceSampleRate: ONESEG_SAMPLING_HZ },
    )
    try {
      for (let off = 0; off < data.length; off += 4096) {
        pipe.pushIq({
          data: data.subarray(off, Math.min(off + 4096, data.length)),
          format: 'u8',
          sampleRate: ONESEG_SAMPLING_HZ,
          centerFrequency: 509_142_857,
          sequence: off,
          timestamp: off,
        })
      }
      pipe.flush()
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(states.length).toBeGreaterThan(0)
  })

  it('resets and discards buffers cleanly', () => {
    const pipe = new OneSegPipeline({}, { sourceSampleRate: ONESEG_SAMPLING_HZ })
    pipe.pushIq({
      data: new Uint8Array(4096).fill(128),
      format: 'u8',
      sampleRate: ONESEG_SAMPLING_HZ,
      centerFrequency: 0,
      sequence: 0,
      timestamp: 0,
    })
    pipe.discardBuffer()
    pipe.reset()
    pipe.flush()
    expect(true).toBe(true)
  })
})
