import { describe, expect, it } from 'vitest'
import { MODE_PARAMS, scatteredPilotIndices } from '../isdbtParams'
import { ChannelEstimator, equalize, estimateChannel, pilotReferenceAt } from './channelEstimation'

describe('estimateChannel', () => {
  it('recovers a flat complex channel at every carrier', () => {
    const mode = 1 as const
    const cps = MODE_PARAMS[mode].carriersPerSegment
    const hRe = 0.8
    const hIm = 0.6
    const bins = { re: new Float32Array(cps), im: new Float32Array(cps) }
    for (const k of scatteredPilotIndices(0, cps)) {
      const p = pilotReferenceAt(k, mode)
      bins.re[k] = p * hRe
      bins.im[k] = p * hIm
    }
    const h = estimateChannel(bins, 0, mode)
    for (let c = 0; c < cps; c++) {
      expect(h.re[c]).toBeCloseTo(hRe, 5)
      expect(h.im[c]).toBeCloseTo(hIm, 5)
    }
  })

  it('interpolates linearly between scattered pilots', () => {
    const mode = 1 as const
    const cps = MODE_PARAMS[mode].carriersPerSegment
    const gain = (k: number): number => 1 + (0.5 * k) / cps
    const bins = { re: new Float32Array(cps), im: new Float32Array(cps) }
    for (const k of scatteredPilotIndices(0, cps)) {
      bins.re[k] = pilotReferenceAt(k, mode) * gain(k)
    }
    const h = estimateChannel(bins, 0, mode)
    for (let c = 1; c < 96; c++) expect(h.re[c]).toBeCloseTo(gain(c), 5)
  })
})

describe('equalize', () => {
  it('inverts the estimated channel', () => {
    const n = 8
    const h = {
      re: Float32Array.from([0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8]),
      im: Float32Array.from([0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6]),
    }
    const bins = { re: new Float32Array(n).fill(0.8), im: new Float32Array(n).fill(0.6) }
    const z = equalize(bins, h)
    for (let i = 0; i < n; i++) {
      expect(z.re[i]).toBeCloseTo(1, 5)
      expect(z.im[i]).toBeCloseTo(0, 5)
    }
  })
})

describe('ChannelEstimator', () => {
  it('matches the stateless estimate on the first symbol', () => {
    const mode = 1 as const
    const cps = MODE_PARAMS[mode].carriersPerSegment
    const bins = { re: new Float32Array(cps).fill(0.5), im: new Float32Array(cps).fill(-0.5) }
    const pure = estimateChannel(bins, 0, mode)
    const est = new ChannelEstimator(mode).estimate(bins, 0)
    for (let c = 0; c < cps; c++) {
      expect(est.re[c]).toBeCloseTo(pure.re[c], 6)
      expect(est.im[c]).toBeCloseTo(pure.im[c], 6)
    }
  })
})
