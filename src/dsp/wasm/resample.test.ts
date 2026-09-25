import { describe, expect, it } from 'vitest'
import { ONESEG_SAMPLING_HZ } from '../isdbtParams'
import { DcRemoval } from '../stages/dcRemoval'
import { NcoCorrector } from '../stages/frequencyCorrection'
import { FractionalResampler, U8Decimator } from '../stages/resample'
import {
  WasmDcRemoval,
  WasmFractionalResampler,
  WasmNcoCorrector,
  WasmU8Decimator,
} from './resample'

const SRC_RATE = 1_200_000

function deterministic(n: number, seed: number): Float32Array {
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = s / 0x3fffffff - 1
  }
  return out
}

function chunks(n: number, sizes: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let off = 0
  let i = 0
  while (off < n) {
    const len = Math.min(sizes[i % sizes.length], n - off)
    out.push([off, off + len])
    off += len
    i++
  }
  return out
}

function concat(parts: Float32Array[]): Float32Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Float32Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

describe('WasmDcRemoval', () => {
  it('matches DcRemoval across uneven chunks', () => {
    const n = 5000
    const re = deterministic(n, 42)
    const im = deterministic(n, 4242)
    const wasm = new WasmDcRemoval(0.001)
    const ts = new DcRemoval(0.001)
    for (const [a, b] of chunks(n, [137, 500, 42, 1000, 3])) {
      const wr = re.slice(a, b)
      const wi = im.slice(a, b)
      const tr = re.slice(a, b)
      const ti = im.slice(a, b)
      wasm.process(wr, wi)
      ts.process(tr, ti)
      for (let i = 0; i < wr.length; i++) {
        expect(wr[i]).toBeCloseTo(tr[i], 4)
        expect(wi[i]).toBeCloseTo(ti[i], 4)
      }
    }
  })

  it('reset clears the running mean', () => {
    const re = deterministic(256, 5)
    const im = deterministic(256, 6)
    const wasm = new WasmDcRemoval(0.01)
    const ts = new DcRemoval(0.01)
    wasm.process(re.slice(), im.slice())
    ts.process(re.slice(), im.slice())
    wasm.reset()
    ts.reset()
    const wr = re.slice()
    const wi = im.slice()
    const tr = re.slice()
    const ti = im.slice()
    wasm.process(wr, wi)
    ts.process(tr, ti)
    for (let i = 0; i < wr.length; i++) {
      expect(wr[i]).toBeCloseTo(tr[i], 4)
      expect(wi[i]).toBeCloseTo(ti[i], 4)
    }
  })
})

describe('WasmFractionalResampler', () => {
  it('matches the whole-block TypeScript output', () => {
    const n = 8000
    const re = deterministic(n, 7)
    const im = deterministic(n, 99)
    const wasm = new WasmFractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ, 450_000)
    const ts = new FractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ, 450_000)
    const w = wasm.process(re, im)
    const t = ts.process(re, im)
    expect(w.re.length).toBe(t.re.length)
    for (let i = 0; i < t.re.length; i++) {
      expect(w.re[i]).toBeCloseTo(t.re[i], 4)
      expect(w.im[i]).toBeCloseTo(t.im[i], 4)
    }
  })

  it('matches TypeScript across uneven chunks with continuity', () => {
    const n = 9000
    const re = deterministic(n, 11)
    const im = deterministic(n, 22)
    const wasm = new WasmFractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ, 450_000)
    const ts = new FractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ, 450_000)
    const wPartsRe: Float32Array[] = []
    const wPartsIm: Float32Array[] = []
    const tPartsRe: Float32Array[] = []
    const tPartsIm: Float32Array[] = []
    for (const [a, b] of chunks(n, [701, 33, 1500, 8, 999])) {
      const w = wasm.process(re.subarray(a, b), im.subarray(a, b))
      const t = ts.process(re.subarray(a, b), im.subarray(a, b))
      wPartsRe.push(w.re)
      wPartsIm.push(w.im)
      tPartsRe.push(t.re)
      tPartsIm.push(t.im)
    }
    const wr = concat(wPartsRe)
    const wi = concat(wPartsIm)
    const tr = concat(tPartsRe)
    const ti = concat(tPartsIm)
    expect(wr.length).toBe(tr.length)
    for (let i = 0; i < tr.length; i++) {
      expect(wr[i]).toBeCloseTo(tr[i], 4)
      expect(wi[i]).toBeCloseTo(ti[i], 4)
    }
  })

  it('is chunk-size invariant', () => {
    const n = 9000
    const re = deterministic(n, 11)
    const im = deterministic(n, 22)
    const a = new WasmFractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ, 450_000)
    const b = new WasmFractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ, 450_000)
    const aRe: Float32Array[] = []
    const aIm: Float32Array[] = []
    const bRe: Float32Array[] = []
    const bIm: Float32Array[] = []
    for (const [lo, hi] of chunks(n, [701, 33, 1500, 8, 999])) {
      const out = a.process(re.subarray(lo, hi), im.subarray(lo, hi))
      aRe.push(out.re)
      aIm.push(out.im)
    }
    for (const [lo, hi] of chunks(n, [4096, 1, 2048, 2047])) {
      const out = b.process(re.subarray(lo, hi), im.subarray(lo, hi))
      bRe.push(out.re)
      bIm.push(out.im)
    }
    const ar = concat(aRe)
    const ai = concat(aIm)
    const br = concat(bRe)
    const bi = concat(bIm)
    expect(ar.length).toBe(br.length)
    for (let i = 0; i < ar.length; i++) {
      expect(ar[i]).toBe(br[i])
      expect(ai[i]).toBe(bi[i])
    }
  })

  it('reset restarts state', () => {
    const n = 4000
    const re = deterministic(n, 3)
    const im = deterministic(n, 4)
    const wasm = new WasmFractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ, 450_000)
    const ts = new FractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ, 450_000)
    wasm.process(re, im)
    ts.process(re, im)
    wasm.reset()
    ts.reset()
    const w = wasm.process(re, im)
    const t = ts.process(re, im)
    expect(w.re.length).toBe(t.re.length)
    for (let i = 0; i < t.re.length; i++) {
      expect(w.re[i]).toBeCloseTo(t.re[i], 4)
      expect(w.im[i]).toBeCloseTo(t.im[i], 4)
    }
  })
})

function u8Bytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n * 2)
  let s = seed
  for (let i = 0; i < out.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = s & 0xff
  }
  return out
}

describe('WasmU8Decimator', () => {
  it.each([100_000, -100_000, 214_000, -214_000])(
    'preserves %s Hz while rejecting signals that alias onto it',
    (frequency) => {
      const rate = ONESEG_SAMPLING_HZ * 2
      const amplitude = (hz: number) => {
        const raw = new Uint8Array(32768)
        for (let s = 0; s < raw.length / 2; s++) {
          const phase = (2 * Math.PI * hz * s) / rate
          raw[2 * s] = Math.round(127.5 + 100 * Math.cos(phase))
          raw[2 * s + 1] = Math.round(127.5 + 100 * Math.sin(phase))
        }
        const decimator = new WasmU8Decimator(2, 0)
        try {
          const out = decimator.process(raw)
          let power = 0
          for (let i = 128; i < out.re.length; i++) {
            power += out.re[i] ** 2 + out.im[i] ** 2
          }
          return Math.sqrt(power / (out.re.length - 128))
        } finally {
          decimator.dispose()
        }
      }
      const wanted = amplitude(frequency)
      const alias = amplitude(frequency - Math.sign(frequency) * ONESEG_SAMPLING_HZ)
      expect(wanted).toBeCloseTo(100 / 127.5, 2)
      expect(alias / wanted).toBeLessThan(0.01)
    },
  )

  it.each([1, 2])('matches U8Decimator across uneven chunks (factor %i)', (factor) => {
    const n = 9000
    const raw = u8Bytes(n, 17)
    const wasm = new WasmU8Decimator(factor, 0.001)
    const ts = new U8Decimator(factor, 0.001)
    const wRe: Float32Array[] = []
    const wIm: Float32Array[] = []
    const tRe: Float32Array[] = []
    const tIm: Float32Array[] = []
    try {
      for (const [a, b] of chunks(n, [701, 33, 1500, 8, 999])) {
        const w = wasm.process(raw.subarray(a * 2, b * 2))
        const t = ts.process(raw.subarray(a * 2, b * 2))
        wRe.push(w.re)
        wIm.push(w.im)
        tRe.push(t.re)
        tIm.push(t.im)
      }
      const wr = concat(wRe)
      const wi = concat(wIm)
      const tr = concat(tRe)
      const ti = concat(tIm)
      expect(wr.length).toBe(tr.length)
      for (let i = 0; i < tr.length; i++) {
        expect(wr[i]).toBeCloseTo(tr[i], 5)
        expect(wi[i]).toBeCloseTo(ti[i], 5)
      }
    } finally {
      wasm.dispose()
    }
  })

  it('is chunk-size invariant and reset restarts state', () => {
    const n = 4000
    const raw = u8Bytes(n, 5)
    const a = new WasmU8Decimator(2, 0.01)
    const b = new WasmU8Decimator(2, 0.01)
    const aRe: Float32Array[] = []
    const bRe: Float32Array[] = []
    try {
      for (const [lo, hi] of chunks(n, [701, 33, 1500, 8]))
        aRe.push(a.process(raw.subarray(lo * 2, hi * 2)).re)
      for (const [lo, hi] of chunks(n, [2048, 1, 1024, 927]))
        bRe.push(b.process(raw.subarray(lo * 2, hi * 2)).re)
      const ar = concat(aRe)
      const br = concat(bRe)
      expect(ar.length).toBe(br.length)
      for (let i = 0; i < ar.length; i++) expect(ar[i]).toBe(br[i])

      a.reset()
      const once = a.process(raw.subarray(0, 2000))
      a.reset()
      const twice = a.process(raw.subarray(0, 2000))
      expect(Array.from(once.re)).toEqual(Array.from(twice.re))
    } finally {
      a.dispose()
      b.dispose()
    }
  })
})

describe('WasmNcoCorrector', () => {
  it.each([0, 0.01, 1234.5, -275_000, 599_999])(
    'bounds oscillator drift over long blocks at %s Hz',
    (offset) => {
      const n = 262_147
      const re = deterministic(n, 123)
      const im = deterministic(n, 456)
      const wasm = new WasmNcoCorrector(offset, SRC_RATE)
      const ts = new NcoCorrector(offset, SRC_RATE)
      try {
        let maxError = 0
        for (const [a, b] of chunks(n, [65_537, 1, 255, 257, 32_768])) {
          const wr = re.slice(a, b)
          const wi = im.slice(a, b)
          const tr = re.slice(a, b)
          const ti = im.slice(a, b)
          wasm.process(wr, wi)
          ts.process(tr, ti)
          for (let i = 0; i < wr.length; i++) {
            maxError = Math.max(maxError, Math.abs(wr[i] - tr[i]), Math.abs(wi[i] - ti[i]))
          }
        }
        expect(maxError).toBeLessThan(2e-7)
      } finally {
        wasm.dispose()
      }
    },
  )

  it('matches NcoCorrector across uneven chunks', () => {
    const n = 4000
    const re = deterministic(n, 123)
    const im = deterministic(n, 456)
    const wasm = new WasmNcoCorrector(1234.5, SRC_RATE)
    const ts = new NcoCorrector(1234.5, SRC_RATE)
    for (const [a, b] of chunks(n, [333, 17, 800, 5])) {
      const wr = re.slice(a, b)
      const wi = im.slice(a, b)
      const tr = re.slice(a, b)
      const ti = im.slice(a, b)
      wasm.process(wr, wi)
      ts.process(tr, ti)
      for (let i = 0; i < wr.length; i++) {
        expect(wr[i]).toBeCloseTo(tr[i], 4)
        expect(wi[i]).toBeCloseTo(ti[i], 4)
      }
    }
  })

  it('honours setOffset and reset', () => {
    const n = 2000
    const re = deterministic(n, 321)
    const im = deterministic(n, 654)
    const wasm = new WasmNcoCorrector(500, SRC_RATE)
    const ts = new NcoCorrector(500, SRC_RATE)
    wasm.process(re.subarray(0, 1000), im.subarray(0, 1000))
    ts.process(re.subarray(0, 1000), im.subarray(0, 1000))
    wasm.setOffset(-275.25)
    ts.setOffset(-275.25)
    const wr = re.slice(1000)
    const wi = im.slice(1000)
    const tr = re.slice(1000)
    const ti = im.slice(1000)
    wasm.process(wr, wi)
    ts.process(tr, ti)
    for (let i = 0; i < wr.length; i++) {
      expect(wr[i]).toBeCloseTo(tr[i], 4)
      expect(wi[i]).toBeCloseTo(ti[i], 4)
    }
    wasm.reset()
    ts.reset()
    const wr2 = re.slice(0, 500)
    const wi2 = im.slice(0, 500)
    const tr2 = re.slice(0, 500)
    const ti2 = im.slice(0, 500)
    wasm.process(wr2, wi2)
    ts.process(tr2, ti2)
    for (let i = 0; i < wr2.length; i++) {
      expect(wr2[i]).toBeCloseTo(tr2[i], 4)
      expect(wi2[i]).toBeCloseTo(ti2[i], 4)
    }
  })
})
