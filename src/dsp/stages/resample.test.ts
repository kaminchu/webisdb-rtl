import { describe, expect, it } from 'vitest'
import { ONESEG_SAMPLING_HZ } from '../isdbtParams'
import { FractionalResampler } from './resample'

const SRC_RATE = 1_200_000

function tone(n: number, freqHz: number, rateHz: number): { re: Float32Array; im: Float32Array } {
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const ph = (2 * Math.PI * freqHz * i) / rateHz
    re[i] = Math.cos(ph)
    im[i] = Math.sin(ph)
  }
  return { re, im }
}

function meanMagnitude(re: Float32Array, im: Float32Array, from: number, to: number): number {
  const a = Math.floor(from)
  const b = Math.floor(to)
  let sum = 0
  for (let i = a; i < b; i++) sum += Math.hypot(re[i], im[i])
  return sum / (b - a)
}

function estimateFrequency(re: Float32Array, im: Float32Array, rateHz: number): number {
  const from = Math.floor(re.length * 0.2)
  const to = Math.floor(re.length * 0.8)
  let sum = 0
  for (let i = from; i < to - 1; i++) {
    const pr = re[i]
    const pi = im[i]
    const cr = re[i + 1]
    const ci = im[i + 1]
    sum += Math.atan2(ci * pr - cr * pi, cr * pr + ci * pi)
  }
  return (sum / (to - 1 - from)) * (rateHz / (2 * Math.PI))
}

describe('FractionalResampler', () => {
  it('preserves a tone below the cutoff with the correct frequency', () => {
    const n = 20_000
    const f0 = 100_000
    const src = tone(n, f0, SRC_RATE)
    const rs = new FractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ)
    const out = rs.process(src.re, src.im)
    expect(estimateFrequency(out.re, out.im, ONESEG_SAMPLING_HZ)).toBeCloseTo(f0, -2)
    expect(meanMagnitude(out.re, out.im, out.re.length * 0.2, out.re.length * 0.8)).toBeCloseTo(
      1,
      1,
    )
  })

  it('attenuates a tone above the cutoff', () => {
    const n = 20_000
    const src = tone(n, 600_000, SRC_RATE)
    const rs = new FractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ)
    const out = rs.process(src.re, src.im)
    const mag = meanMagnitude(out.re, out.im, out.re.length * 0.2, out.re.length * 0.8)
    expect(mag).toBeLessThan(0.05)
  })

  it('produces the expected output length ratio', () => {
    const n = 12_000
    const src = tone(n, 50_000, SRC_RATE)
    const rs = new FractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ)
    const out = rs.process(src.re, src.im)
    const expected = n * (ONESEG_SAMPLING_HZ / SRC_RATE)
    expect(Math.abs(out.re.length - expected)).toBeLessThan(expected * 0.01)
  })

  it('is chunk-size invariant', () => {
    const n = 8_000
    const f0 = 120_000
    const src = tone(n, f0, SRC_RATE)
    const whole = new FractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ).process(src.re, src.im)
    const chunked = new FractionalResampler(SRC_RATE, ONESEG_SAMPLING_HZ)
    const parts: number[] = []
    for (let off = 0; off < n; off += 700) {
      const block = chunked.process(
        src.re.subarray(off, Math.min(off + 700, n)),
        src.im.subarray(off, Math.min(off + 700, n)),
      )
      parts.push(...Array.from(block.re))
    }
    expect(parts.length).toBeGreaterThanOrEqual(whole.re.length - 2)
    for (let i = 0; i < whole.re.length; i++) {
      expect(parts[i]).toBeCloseTo(whole.re[i], 4)
    }
  })
})
