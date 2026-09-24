import { describe, expect, it } from 'vitest'
import { DcRemoval, removeDc } from './dcRemoval'

describe('removeDc', () => {
  it('removes a constant complex offset', () => {
    const n = 5000
    const re = new Float32Array(n).fill(0.5)
    const im = new Float32Array(n).fill(-0.3)
    removeDc(re, im, 0.01)
    expect(Math.abs(re[n - 1])).toBeLessThan(1e-3)
    expect(Math.abs(im[n - 1])).toBeLessThan(1e-3)
  })

  it('preserves a high-frequency component around zero mean', () => {
    const n = 4000
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * i) / 16)
    removeDc(re, im, 0.01)
    let energy = 0
    for (let i = 2000; i < n; i++) energy += re[i] * re[i]
    expect(energy / (n - 2000)).toBeGreaterThan(0.4)
  })
})

describe('DcRemoval', () => {
  it('matches the pure function when fed in one block', () => {
    const n = 1000
    const re = new Float32Array(n).fill(0.2)
    const im = new Float32Array(n).fill(0.1)
    const a = re.slice()
    const b = im.slice()
    removeDc(a, b, 0.02)
    const dc = new DcRemoval(0.02)
    dc.process(re, im)
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(a[i], 5)
      expect(im[i]).toBeCloseTo(b[i], 5)
    }
  })
})
