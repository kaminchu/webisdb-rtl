import { describe, expect, it } from 'vitest'
import { ChannelEstimator, equalize, estimateChannel } from '../stages/channelEstimation'
import { demodulatePlane, demodulatePlaneSoft } from '../stages/carrierDemod'
import { CarrierModulation, MODE_PARAMS, TransmissionMode } from '../isdbtParams'
import {
  WasmChannelEstimator,
  WasmSymbolDemapper,
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

describe('WasmSymbolDemapper', () => {
  const mode3: TransmissionMode = TransmissionMode.Mode3
  const n = MODE_PARAMS[mode3].oneSegFftSize
  const cps3 = MODE_PARAMS[mode3].carriersPerSegment
  const dataCount = MODE_PARAMS[mode3].dataCarriersPerSegment
  const carrierBase = n / 2 - cps3 / 2
  const dataIdx = Array.from({ length: dataCount }, (_, i) => (i * 7) % cps3)

  function fftFromCarriers(carriers: { re: Float32Array; im: Float32Array }): {
    re: Float32Array
    im: Float32Array
  } {
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let c = 0; c < cps3; c++) {
      const bin = (carrierBase + c + n) % n
      re[bin] = carriers.re[c]
      im[bin] = carriers.im[c]
    }
    return { re, im }
  }

  it('matches estimateChannel + equalize at the selected data carriers', () => {
    const demapper = new WasmSymbolDemapper(mode3, [dataIdx, dataIdx, dataIdx, dataIdx], 1)
    const outRe = new Float32Array(dataCount)
    const outIm = new Float32Array(dataCount)
    for (const symbolIndex of symbolIndices) {
      const carriers = plane(cps3, 7000 + symbolIndex, 1.5)
      const fft = fftFromCarriers(carriers)
      const h = estimateChannel(carriers, symbolIndex, mode3)
      const z = equalize(carriers, h)
      demapper.process(fft.re, fft.im, n, carrierBase, 0, symbolIndex, outRe, outIm, 0)
      for (let k = 0; k < dataCount; k++) {
        expect(outRe[k]).toBeCloseTo(z.re[dataIdx[k]], 4)
        expect(outIm[k]).toBeCloseTo(z.im[dataIdx[k]], 4)
      }
    }
    demapper.dispose()
  })

  it('matches ChannelEstimator temporal smoothing across symbols', () => {
    const expected = new ChannelEstimator(mode3, 0.5)
    const demapper = new WasmSymbolDemapper(mode3, [dataIdx, dataIdx, dataIdx, dataIdx], 0.5)
    const outRe = new Float32Array(dataCount)
    const outIm = new Float32Array(dataCount)
    for (let s = 0; s < 8; s++) {
      const carriers = plane(cps3, 8000 + s * 13, 1.5)
      const fft = fftFromCarriers(carriers)
      const h = expected.estimate(carriers, s)
      const z = equalize(carriers, h)
      demapper.process(fft.re, fft.im, n, carrierBase, 0, s, outRe, outIm, 0)
      for (let k = 0; k < dataCount; k++) {
        expect(outRe[k]).toBeCloseTo(z.re[dataIdx[k]], 4)
        expect(outIm[k]).toBeCloseTo(z.im[dataIdx[k]], 4)
      }
    }
    demapper.dispose()
  })
})
