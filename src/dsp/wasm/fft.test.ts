import { describe, expect, it } from 'vitest'
import { TsFftBackend } from '../stages/fft'
import { WasmFftBackend } from './fft'

function deterministic(n: number, seed: number): Float32Array {
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = s / 0x3fffffff - 1
  }
  return out
}

describe('WasmFftBackend', () => {
  const wasm = new WasmFftBackend()
  const ts = new TsFftBackend()

  it('exposes the backend interface', () => {
    expect(wasm.name).toBe('wasm-fft')
  })

  it('matches the TypeScript forward FFT for every one-seg size', () => {
    for (const n of [4, 256, 512, 1024]) {
      const re = deterministic(n, 12345)
      const im = deterministic(n, 777)
      const wr = re.slice()
      const wi = im.slice()
      wasm.forward(wr, wi)
      ts.forward(re, im)
      for (let i = 0; i < n; i++) {
        expect(wr[i]).toBeCloseTo(re[i], 4)
        expect(wi[i]).toBeCloseTo(im[i], 4)
      }
    }
  })

  it('inverts a forward transform', () => {
    const n = 512
    const re = deterministic(n, 99)
    const im = deterministic(n, 123)
    const origRe = re.slice()
    const origIm = im.slice()
    wasm.forward(re, im)
    wasm.inverse(re, im)
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(origRe[i], 4)
      expect(im[i]).toBeCloseTo(origIm[i], 4)
    }
  })

  it('forwardFrom matches forward on a slice of a larger buffer', () => {
    const n = 512
    const offset = 37
    const total = offset + n + 11
    const srcRe = deterministic(total, 321)
    const srcIm = deterministic(total, 654)
    const expectedRe = srcRe.slice(offset, offset + n)
    const expectedIm = srcIm.slice(offset, offset + n)
    wasm.forward(expectedRe, expectedIm)

    const dstRe = new Float32Array(n)
    const dstIm = new Float32Array(n)
    wasm.forwardFrom(srcRe, srcIm, offset, n, dstRe, dstIm)
    for (let i = 0; i < n; i++) {
      expect(dstRe[i]).toBeCloseTo(expectedRe[i], 5)
      expect(dstIm[i]).toBeCloseTo(expectedIm[i], 5)
    }
  })

  it('peaks at the bin of a real tone', () => {
    const n = 256
    const k0 = 20
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k0 * i) / n)
    wasm.forward(re, im)
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
  })
})
