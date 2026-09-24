import { describe, expect, it } from 'vitest'
import { ONESEG_SAMPLING_HZ } from '../isdbtParams'
import { OfdmSynchronizer } from './ofdmSync'

interface Synth {
  re: Float32Array
  im: Float32Array
  cp: number
  symbolLength: number
}

function build(count: number, fftSize: number, giRatio: number, offsetHz: number): Synth {
  const cp = fftSize / giRatio
  const symbolLength = fftSize + cp
  const total = count * symbolLength
  const re = new Float32Array(total)
  const im = new Float32Array(total)
  let s = 246813579
  const next = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x3fffffff - 1
  }
  const uRe = new Float32Array(fftSize)
  const uIm = new Float32Array(fftSize)
  for (let sym = 0; sym < count; sym++) {
    for (let i = 0; i < fftSize; i++) {
      uRe[i] = next()
      uIm[i] = next()
    }
    const base = sym * symbolLength
    for (let i = 0; i < cp; i++) {
      re[base + i] = uRe[fftSize - cp + i]
      im[base + i] = uIm[fftSize - cp + i]
    }
    for (let i = 0; i < fftSize; i++) {
      re[base + cp + i] = uRe[i]
      im[base + cp + i] = uIm[i]
    }
  }
  if (offsetHz !== 0) {
    const step = (2 * Math.PI * offsetHz) / ONESEG_SAMPLING_HZ
    for (let t = 0; t < total; t++) {
      const ph = step * t
      const c = Math.cos(ph)
      const sn = Math.sin(ph)
      const r = re[t] * c - im[t] * sn
      const q = re[t] * sn + im[t] * c
      re[t] = r
      im[t] = q
    }
  }
  return { re, im, cp, symbolLength }
}

describe('OfdmSynchronizer', () => {
  it('finds every symbol boundary in one block', () => {
    const count = 16
    const synth = build(count, 256, 8, 0)
    const sync = new OfdmSynchronizer(256, 8, ONESEG_SAMPLING_HZ)
    const out = sync.process(synth.re, synth.im)
    expect(out.symbolStarts.length).toBeGreaterThanOrEqual(count - 1)
    for (let k = 0; k < out.symbolStarts.length; k++) {
      expect(out.symbolStarts[k] % synth.symbolLength).toBe(synth.cp)
      if (k > 0) {
        expect(out.symbolStarts[k] - out.symbolStarts[k - 1]).toBe(synth.symbolLength)
      }
    }
  })

  it('works when fed in small blocks', () => {
    const count = 12
    const synth = build(count, 256, 8, 0)
    const sync = new OfdmSynchronizer(256, 8, ONESEG_SAMPLING_HZ)
    const starts: number[] = []
    const step = 300
    for (let off = 0; off < synth.re.length; off += step) {
      const chunkRe = synth.re.subarray(off, Math.min(off + step, synth.re.length))
      const chunkIm = synth.im.subarray(off, Math.min(off + step, synth.im.length))
      starts.push(...sync.process(chunkRe, chunkIm).symbolStarts)
    }
    expect(starts.length).toBeGreaterThanOrEqual(count - 1)
    for (let k = 0; k < starts.length; k++) {
      expect(starts[k] % synth.symbolLength).toBe(synth.cp)
      if (k > 0) expect(starts[k] - starts[k - 1]).toBe(synth.symbolLength)
    }
  })

  it('keeps sync and reports the fractional offset', () => {
    const f0 = 150
    const synth = build(10, 256, 16, f0)
    const sync = new OfdmSynchronizer(256, 16, ONESEG_SAMPLING_HZ)
    const out = sync.process(synth.re, synth.im)
    expect(out.symbolStarts.length).toBeGreaterThanOrEqual(9)
    expect(out.fractionalOffsetHz).not.toBeNull()
    expect(out.fractionalOffsetHz ?? 0).toBeCloseTo(f0, 0)
  })
})
