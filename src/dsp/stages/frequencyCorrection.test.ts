import { describe, expect, it } from 'vitest'
import { ONESEG_SAMPLING_HZ } from '../isdbtParams'
import { FrequencyOffsetEstimator, NcoCorrector } from './frequencyCorrection'

interface Synth {
  re: Float32Array
  im: Float32Array
  cp: number
  symbolLength: number
}

function buildOfdmSymbols(
  count: number,
  fftSize: number,
  giRatio: number,
  offsetHz: number,
  sampleRateHz: number,
): Synth {
  const cp = fftSize / giRatio
  const symbolLength = fftSize + cp
  const total = count * symbolLength
  const re = new Float32Array(total)
  const im = new Float32Array(total)
  let s = 987654321
  const next = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x3fffffff - 1
  }
  const usefulRe = new Float32Array(fftSize)
  const usefulIm = new Float32Array(fftSize)
  for (let sym = 0; sym < count; sym++) {
    for (let i = 0; i < fftSize; i++) {
      usefulRe[i] = next()
      usefulIm[i] = next()
    }
    const base = sym * symbolLength
    for (let i = 0; i < cp; i++) {
      re[base + i] = usefulRe[fftSize - cp + i]
      im[base + i] = usefulIm[fftSize - cp + i]
    }
    for (let i = 0; i < fftSize; i++) {
      re[base + cp + i] = usefulRe[i]
      im[base + cp + i] = usefulIm[i]
    }
  }
  const step = (2 * Math.PI * offsetHz) / sampleRateHz
  for (let t = 0; t < total; t++) {
    const ph = step * t
    const c = Math.cos(ph)
    const sn = Math.sin(ph)
    const r = re[t] * c - im[t] * sn
    const q = re[t] * sn + im[t] * c
    re[t] = r
    im[t] = q
  }
  return { re, im, cp, symbolLength }
}

describe('FrequencyOffsetEstimator', () => {
  it('finds the timing peak and fractional offset', () => {
    const fftSize = 256
    const giRatio = 8
    const f0 = 200
    const synth = buildOfdmSymbols(8, fftSize, giRatio, f0, ONESEG_SAMPLING_HZ)
    const est = new FrequencyOffsetEstimator(fftSize, giRatio, ONESEG_SAMPLING_HZ)
    const out = est.estimate(synth.re, synth.im)
    expect(out.timingIndex).toBeGreaterThanOrEqual(0)
    expect(out.timingIndex % synth.symbolLength).toBe(0)
    expect(out.metric).toBeGreaterThan(0)
    expect(out.fractionalOffsetHz).toBeCloseTo(f0, 0)
  })

  it('reports a negative offset', () => {
    const fftSize = 128
    const giRatio = 16
    const synth = buildOfdmSymbols(6, fftSize, giRatio, -300, ONESEG_SAMPLING_HZ)
    const est = new FrequencyOffsetEstimator(fftSize, giRatio, ONESEG_SAMPLING_HZ)
    const out = est.estimate(synth.re, synth.im)
    expect(out.fractionalOffsetHz).toBeCloseTo(-300, 0)
  })
})

describe('NcoCorrector', () => {
  it('removes a known offset', () => {
    const fftSize = 256
    const giRatio = 8
    const f0 = 250
    const clean = buildOfdmSymbols(4, fftSize, giRatio, 0, ONESEG_SAMPLING_HZ)
    const dirty = buildOfdmSymbols(4, fftSize, giRatio, f0, ONESEG_SAMPLING_HZ)
    const nco = new NcoCorrector(f0, ONESEG_SAMPLING_HZ)
    nco.process(dirty.re, dirty.im)
    let maxErr = 0
    for (let i = 0; i < clean.re.length; i++) {
      maxErr = Math.max(
        maxErr,
        Math.abs(dirty.re[i] - clean.re[i]),
        Math.abs(dirty.im[i] - clean.im[i]),
      )
    }
    expect(maxErr).toBeLessThan(1e-3)
  })
})
