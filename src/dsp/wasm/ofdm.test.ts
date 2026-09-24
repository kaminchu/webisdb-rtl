import { describe, expect, it } from 'vitest'
import { OfdmSynchronizer } from '../stages/ofdmSync'
import { FrequencyOffsetEstimator } from '../stages/frequencyCorrection'
import { WasmFrequencyOffsetEstimator, WasmOfdmSynchronizer } from './ofdm'

const FFT = 512
const GI_RATIO = 4
const CP = FFT / GI_RATIO
const SYMBOL = FFT + CP
const SAMPLE_RATE = 1_000_000
const FREQ_OFFSET = 123.4

interface Signal {
  re: Float32Array
  im: Float32Array
}

function buildOfdmSignal(symbolCount: number, offsetHz: number): Signal {
  const total = symbolCount * SYMBOL
  const baseRe = new Float64Array(total)
  const baseIm = new Float64Array(total)
  const carriers = [3, 27, 88, 140, 199, 231, 255]
  let s = 123456789
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x3fffffff - 1
  }
  for (let m = 0; m < symbolCount; m++) {
    const p = m * SYMBOL
    const amp = carriers.map(() => 0.5 + 0.5 * Math.abs(rnd()))
    const phase = carriers.map(() => rnd() * Math.PI)
    const usefulRe = new Float64Array(FFT)
    const usefulIm = new Float64Array(FFT)
    for (let c = 0; c < carriers.length; c++) {
      const k = carriers[c]
      for (let i = 0; i < FFT; i++) {
        const ang = (2 * Math.PI * k * i) / FFT + phase[c]
        usefulRe[i] += amp[c] * Math.cos(ang)
        usefulIm[i] += amp[c] * Math.sin(ang)
      }
    }
    for (let i = 0; i < CP; i++) {
      baseRe[p + i] = usefulRe[FFT - CP + i]
      baseIm[p + i] = usefulIm[FFT - CP + i]
    }
    for (let i = 0; i < FFT; i++) {
      baseRe[p + CP + i] = usefulRe[i]
      baseIm[p + CP + i] = usefulIm[i]
    }
  }
  const re = new Float32Array(total)
  const im = new Float32Array(total)
  for (let n = 0; n < total; n++) {
    const ang = (2 * Math.PI * offsetHz * n) / SAMPLE_RATE
    const c = Math.cos(ang)
    const sn = Math.sin(ang)
    re[n] = baseRe[n] * c - baseIm[n] * sn
    im[n] = baseRe[n] * sn + baseIm[n] * c
  }
  return { re, im }
}

function buildNoise(len: number, seed: number): Signal {
  const re = new Float32Array(len)
  const im = new Float32Array(len)
  let s = seed
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x3fffffff - 1
  }
  for (let i = 0; i < len; i++) {
    re[i] = rnd()
    im[i] = rnd()
  }
  return { re, im }
}

interface SyncLike {
  process(
    re: Float32Array,
    im: Float32Array,
  ): {
    symbolStarts: number[]
    fractionalOffsetHz: number | null
    metric: number
    gammaMagnitude: number
    phi: number
  }
}

function feed(sync: SyncLike, signal: Signal, chunk: number) {
  const out: ReturnType<SyncLike['process']>[] = []
  for (let o = 0; o < signal.re.length; o += chunk) {
    out.push(sync.process(signal.re.subarray(o, o + chunk), signal.im.subarray(o, o + chunk)))
  }
  return out
}

function expectSameTrace(wasm: SyncLike, ts: SyncLike, signal: Signal, chunk: number): void {
  const w = feed(wasm, signal, chunk)
  const t = feed(ts, signal, chunk)
  expect(w.length).toBe(t.length)
  for (let i = 0; i < w.length; i++) {
    expect(w[i].symbolStarts).toEqual(t[i].symbolStarts)
    expect(w[i].metric).toBeCloseTo(t[i].metric, 9)
    expect(w[i].gammaMagnitude).toBeCloseTo(t[i].gammaMagnitude, 9)
    expect(w[i].phi).toBeCloseTo(t[i].phi, 9)
    if (t[i].fractionalOffsetHz === null) {
      expect(w[i].fractionalOffsetHz).toBeNull()
    } else {
      expect(w[i].fractionalOffsetHz).toBeCloseTo(t[i].fractionalOffsetHz as number, 6)
    }
  }
}

describe('WasmOfdmSynchronizer', () => {
  it('matches the TypeScript synchronizer on a CP-OFDM signal in chunks', () => {
    const signal = buildOfdmSignal(12, FREQ_OFFSET)
    const wasm = new WasmOfdmSynchronizer(FFT, GI_RATIO, SAMPLE_RATE)
    const ts = new OfdmSynchronizer(FFT, GI_RATIO, SAMPLE_RATE)
    expectSameTrace(wasm, ts, signal, 333)

    const w = feed(wasm, { re: new Float32Array(0), im: new Float32Array(0) }, 1)
    expect(w).toHaveLength(0)
    const starts = feed(new WasmOfdmSynchronizer(FFT, GI_RATIO, SAMPLE_RATE), signal, 333).flatMap(
      (r) => r.symbolStarts,
    )
    expect(starts.length).toBeGreaterThan(5)
    for (let s = 0; s < starts.length; s++) {
      expect(starts[s]).toBe(CP + s * SYMBOL)
    }
  })

  it('matches the TypeScript synchronizer with timing tracking', () => {
    const signal = buildOfdmSignal(10, FREQ_OFFSET)
    const wasm = new WasmOfdmSynchronizer(FFT, GI_RATIO, SAMPLE_RATE, true)
    const ts = new OfdmSynchronizer(FFT, GI_RATIO, SAMPLE_RATE, true)
    expectSameTrace(wasm, ts, signal, 701)
  })

  it('matches the TypeScript synchronizer on unlocked noise', () => {
    const signal = buildNoise(6000, 4242)
    const wasm = new WasmOfdmSynchronizer(FFT, GI_RATIO, SAMPLE_RATE)
    const ts = new OfdmSynchronizer(FFT, GI_RATIO, SAMPLE_RATE)
    expectSameTrace(wasm, ts, signal, 512)
  })

  it('resets back to the initial state', () => {
    const signal = buildOfdmSignal(6, FREQ_OFFSET)
    const wasm = new WasmOfdmSynchronizer(FFT, GI_RATIO, SAMPLE_RATE)
    const ts = new OfdmSynchronizer(FFT, GI_RATIO, SAMPLE_RATE)
    feed(wasm, signal, 256)
    feed(ts, signal, 256)
    wasm.reset()
    ts.reset()
    expectSameTrace(wasm, ts, signal, 256)
  })
})

describe('WasmFrequencyOffsetEstimator', () => {
  it('matches the TypeScript estimator on a CP-OFDM signal', () => {
    const signal = buildOfdmSignal(6, FREQ_OFFSET)
    const wasm = new WasmFrequencyOffsetEstimator(FFT, GI_RATIO, SAMPLE_RATE)
    const ts = new FrequencyOffsetEstimator(FFT, GI_RATIO, SAMPLE_RATE)
    const w = wasm.estimate(signal.re, signal.im)
    const t = ts.estimate(signal.re, signal.im)
    expect(w.timingIndex).toBe(t.timingIndex)
    expect(w.metric).toBeCloseTo(t.metric, 6)
    expect(w.fractionalOffsetHz).toBeCloseTo(t.fractionalOffsetHz, 6)
    expect(w.fractionalOffsetHz).toBeCloseTo(FREQ_OFFSET, 1)
  })

  it('matches the TypeScript estimator with maxSearch and on noise', () => {
    const signal = buildOfdmSignal(6, FREQ_OFFSET)
    const noise = buildNoise(4000, 7777)
    const wasm = new WasmFrequencyOffsetEstimator(FFT, GI_RATIO, SAMPLE_RATE)
    const ts = new FrequencyOffsetEstimator(FFT, GI_RATIO, SAMPLE_RATE)
    for (const [re, im] of [
      [signal.re, signal.im],
      [noise.re, noise.im],
    ] as const) {
      for (const maxSearch of [Number.POSITIVE_INFINITY, 100, 37.5]) {
        const w = wasm.estimate(re, im, maxSearch)
        const t = ts.estimate(re, im, maxSearch)
        expect(w.timingIndex).toBe(t.timingIndex)
        expect(w.metric).toBeCloseTo(t.metric, 6)
        expect(w.fractionalOffsetHz).toBeCloseTo(t.fractionalOffsetHz, 6)
      }
    }
  })

  it('matches the TypeScript estimator when the block is too short', () => {
    const short = buildNoise(100, 99)
    const wasm = new WasmFrequencyOffsetEstimator(FFT, GI_RATIO, SAMPLE_RATE)
    const ts = new FrequencyOffsetEstimator(FFT, GI_RATIO, SAMPLE_RATE)
    expect(wasm.estimate(short.re, short.im)).toEqual(ts.estimate(short.re, short.im))
  })
})
