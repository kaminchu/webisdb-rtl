import { describe, expect, it } from 'vitest'
import { CarrierModulation, CodeRate, MODE_PARAMS } from './isdbtParams'
import type { TmccInfo } from '../models/tmcc'
import { OneSegDecoder } from './oneSegDecoder'
import type { ComplexPlane } from './stages/carrierDemod'

const CARRIERS = MODE_PARAMS[3].dataCarriersPerSegment

function makeTmcc(modulation: CarrierModulation, codeRate: CodeRate): TmccInfo {
  return {
    locked: true,
    mode: 3,
    guardIntervalRatio: 8,
    partialReception: true,
    systemDescriptor: 0,
    layers: {
      A: { modulation, codeRate, timeInterleave: 0, segments: 1 },
      B: null,
      C: null,
    },
    frameCount: 0,
  }
}

function planes(count: number, seed: number): ComplexPlane[] {
  const out: ComplexPlane[] = []
  let state = seed
  const rnd = (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x3fffffff - 1
  }
  for (let s = 0; s < count; s++) {
    const re = new Float32Array(CARRIERS)
    const im = new Float32Array(CARRIERS)
    for (let k = 0; k < CARRIERS; k++) {
      re[k] = rnd() > 0 ? 1 : -1
      im[k] = rnd() > 0 ? 1 : -1
    }
    out.push({ re, im })
  }
  return out
}

describe('OneSegDecoder', () => {
  it('rejects carriers that do not match the segment width', () => {
    const decoder = new OneSegDecoder(makeTmcc(CarrierModulation.QPSK, CodeRate.R1_2))
    expect(() => decoder.decode([{ re: new Float32Array(8), im: new Float32Array(8) }])).toThrow()
  })

  it('is deterministic for the same input', () => {
    const symbols = planes(64, 12345)
    const decoder = new OneSegDecoder(makeTmcc(CarrierModulation.QPSK, CodeRate.R1_2))
    const first = decoder.decode(symbols)
    const second = decoder.decode(symbols)
    expect(Array.from(first)).toEqual(Array.from(second))
  })

  it('resets its streaming state', () => {
    const decoder = new OneSegDecoder(makeTmcc(CarrierModulation.QPSK, CodeRate.R1_2))
    decoder.decode(planes(16, 7))
    decoder.reset()
    expect(decoder.tsStats.packets).toBe(0)
    expect(decoder.decode(planes(16, 7)).length).toBe(0)
  })
})
