import { describe, expect, it } from 'vitest'
import { ChannelEstimator, equalize, estimateChannel } from '../stages/channelEstimation'
import { demodulatePlane, demodulatePlaneSoft } from '../stages/carrierDemod'
import { CarrierModulation, MODE_PARAMS, TransmissionMode } from '../isdbtParams'
import {
  WasmChannelEstimator,
  demodulatePlaneSoftWasm,
  demodulatePlaneWasm,
  equalizeWasm,
  estimateChannelWasm,
} from './demap'

function rand(n: number, seed: number, scale = 1): Float32Array {
  const out = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = (s / 0x3fffffff - 1) * scale
  }
  return out
}

function plane(n: number, seed: number, scale = 1) {
  return { re: rand(n, seed, scale), im: rand(n, seed + 1, scale) }
}

function expectClose(actual: Float32Array, expected: Float32Array): void {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i], 4)
}

const mode: TransmissionMode = TransmissionMode.Mode1
const cps = MODE_PARAMS[mode].carriersPerSegment
const symbolIndices = [0, 1, 2, 3, 5, 10, 42]
const modulations = [
  CarrierModulation.DQPSK,
  CarrierModulation.QPSK,
  CarrierModulation.QAM16,
  CarrierModulation.QAM64,
]

describe('wasm demap', () => {
  it('matches estimateChannel for every symbol index', () => {
    for (const symbolIndex of symbolIndices) {
      const bins = plane(cps, 100 + symbolIndex)
      const expected = estimateChannel(bins, symbolIndex, mode)
      const actual = estimateChannelWasm(bins, symbolIndex, mode)
      expectClose(actual.re, expected.re)
      expectClose(actual.im, expected.im)
    }
  })

  it('matches ChannelEstimator temporal smoothing across symbols', () => {
    const expected = new ChannelEstimator(mode, 0.5)
    const actual = new WasmChannelEstimator(mode, 0.5)
    for (let s = 0; s < 8; s++) {
      const bins = plane(cps, 5000 + s * 7)
      const e = expected.estimate(bins, s)
      const a = actual.estimate(bins, s)
      expectClose(a.re, e.re)
      expectClose(a.im, e.im)
    }
  })

  it('matches ChannelEstimator with a custom alpha', () => {
    const expected = new ChannelEstimator(mode, 0.3)
    const actual = new WasmChannelEstimator(mode, 0.3)
    for (const s of [0, 1, 2, 6, 11]) {
      const bins = plane(cps, 9000 + s * 31)
      const e = expected.estimate(bins, s)
      const a = actual.estimate(bins, s)
      expectClose(a.re, e.re)
      expectClose(a.im, e.im)
    }
  })

  it('reset drops the previous estimate', () => {
    const binA = plane(cps, 300)
    const binB = plane(cps, 700)
    const ts = new ChannelEstimator(mode, 0.4)
    const wasm = new WasmChannelEstimator(mode, 0.4)
    ts.estimate(binA, 0)
    wasm.estimate(binA, 0)
    ts.reset()
    wasm.reset()
    const fresh = new ChannelEstimator(mode, 0.4)
    const expected = ts.estimate(binB, 1)
    const reference = fresh.estimate(binB, 1)
    const actual = wasm.estimate(binB, 1)
    expectClose(expected.re, reference.re)
    expectClose(actual.re, expected.re)
    expectClose(actual.im, expected.im)
  })

  it('matches equalize', () => {
    const bins = plane(cps, 1234)
    const h = plane(cps, 4321)
    const expected = equalize(bins, h)
    const actual = equalizeWasm(bins, h)
    expectClose(actual.re, expected.re)
    expectClose(actual.im, expected.im)
  })

  it('matches demodulatePlane exactly for all modulations', () => {
    for (const modulation of modulations) {
      for (const symbolIndex of symbolIndices) {
        const curr = plane(cps, 20000 + modulation * 100 + symbolIndex, 1.5)
        const prev = plane(cps, 30000 + modulation * 100 + symbolIndex, 1.5)
        const expected = demodulatePlane(modulation, curr, prev)
        const actual = demodulatePlaneWasm(modulation, curr, prev)
        expect(actual).toEqual(expected)
      }
    }
  })

  it('matches demodulatePlaneSoft exactly for all modulations', () => {
    for (const modulation of modulations) {
      for (const symbolIndex of symbolIndices) {
        const curr = plane(cps, 40000 + modulation * 100 + symbolIndex, 1.5)
        const prev = plane(cps, 50000 + modulation * 100 + symbolIndex, 1.5)
        const expected = demodulatePlaneSoft(modulation, curr, prev)
        const actual = demodulatePlaneSoftWasm(modulation, curr, prev)
        expect(actual).toEqual(expected)
      }
    }
  })

  it('throws for DQPSK without a previous plane', () => {
    const curr = plane(cps, 77)
    expect(() => demodulatePlaneWasm(CarrierModulation.DQPSK, curr, null)).toThrow()
    expect(() => demodulatePlaneSoftWasm(CarrierModulation.DQPSK, curr, null)).toThrow()
  })
})
