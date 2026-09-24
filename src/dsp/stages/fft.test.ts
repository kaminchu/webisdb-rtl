import { describe, expect, it } from 'vitest'
import { TsFftBackend, fftForward, fftInverse } from './fft'

function deterministic(n: number): Float32Array {
  const out = new Float32Array(n)
  let s = 123456789
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = s / 0x3fffffff - 1
  }
  return out
}

describe('FFT', () => {
  it('peaks at the bin of a real tone', () => {
    const n = 256
    const k0 = 20
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k0 * i) / n)
    fftForward(re, im)
    let peak = 0
    let peakMag = -1
    for (let i = 0; i < n; i++) {
      const mag = Math.hypot(re[i], im[i])
      if (mag > peakMag) {
        peakMag = mag
        peak = i
      }
    }
    expect(peak).toBe(k0)
    expect(Math.hypot(re[n - k0], im[n - k0])).toBeCloseTo(peakMag, 6)
  })

  it('inverts a forward transform', () => {
    const n = 512
    const re = deterministic(n)
    const im = deterministic(n + 1).subarray(0, n)
    const origRe = re.slice()
    const origIm = im.slice()
    fftForward(re, im)
    fftInverse(re, im)
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(origRe[i], 4)
      expect(im[i]).toBeCloseTo(origIm[i], 4)
    }
  })

  it('satisfies Parseval', () => {
    const n = 128
    const re = deterministic(n)
    const im = deterministic(n + 7).subarray(0, n)
    let time = 0
    for (let i = 0; i < n; i++) time += re[i] * re[i] + im[i] * im[i]
    fftForward(re, im)
    let freq = 0
    for (let i = 0; i < n; i++) freq += re[i] * re[i] + im[i] * im[i]
    expect(freq / n).toBeCloseTo(time, 3)
  })

  it('exposes the backend interface', () => {
    const backend = new TsFftBackend()
    expect(backend.name).toBe('ts-radix2')
    const re = Float32Array.from([1, 2, 3, 4])
    const im = new Float32Array(4)
    backend.forward(re, im)
    backend.inverse(re, im)
    expect(re[0]).toBeCloseTo(1, 5)
    expect(re[3]).toBeCloseTo(4, 5)
  })
})
