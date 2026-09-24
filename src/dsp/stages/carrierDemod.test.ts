import { describe, expect, it } from 'vitest'
import { CarrierModulation } from '../isdbtParams'
import {
  DQPSK_PHASE_STEP,
  bitsPerCarrier,
  demodulatePlane,
  dqpskSlice,
  packBits,
  qam16Slice,
  qam64Slice,
  qpskSlice,
  serializeCarrierBytes,
  type ComplexPlane,
} from './carrierDemod'

const TWO_PI = Math.PI * 2

function inverseGray(label: number): number {
  return label ^ (label >> 1)
}

function plane(re: number[], im: number[]): ComplexPlane {
  return { re: Float32Array.from(re), im: Float32Array.from(im) }
}

describe('DQPSK', () => {
  it('recovers Gray-coded differential labels', () => {
    const labels = Uint8Array.from([0, 1, 2, 3, 3, 2, 1, 0, 0, 1])
    const n = labels.length
    const prev = plane(
      Array.from<number>({ length: n }).fill(1),
      Array.from<number>({ length: n }).fill(0),
    )
    const re = Array.from<number>({ length: n }).fill(0)
    const im = Array.from<number>({ length: n }).fill(0)
    const phase = Array.from<number>({ length: n }).fill(0)
    for (let k = 0; k < n; k++) {
      phase[k] += inverseGray(labels[k]) * DQPSK_PHASE_STEP
      re[k] = Math.cos(phase[k])
      im[k] = Math.sin(phase[k])
    }
    expect(Array.from(demodulatePlane(CarrierModulation.DQPSK, plane(re, im), prev))).toEqual(
      Array.from(labels),
    )
  })

  it('quantises each pi/2 sector', () => {
    expect(dqpskSlice(0)).toBe(0)
    expect(dqpskSlice(DQPSK_PHASE_STEP)).toBe(1)
    expect(dqpskSlice(Math.PI)).toBe(3)
    expect(dqpskSlice(3 * DQPSK_PHASE_STEP)).toBe(2)
    expect(dqpskSlice(-DQPSK_PHASE_STEP + TWO_PI)).toBe(2)
  })
})

describe('coherent slicers', () => {
  it('slices QPSK', () => {
    const s = 1 / Math.SQRT2
    expect(qpskSlice(s, s)).toBe(0)
    expect(qpskSlice(s, -s)).toBe(1)
    expect(qpskSlice(-s, s)).toBe(2)
    expect(qpskSlice(-s, -s)).toBe(3)
  })

  it('slices every 16QAM label', () => {
    const scale = Math.sqrt(10)
    for (let label = 0; label < 16; label++) {
      const iSign = (label >> 3) & 1
      const qSign = (label >> 2) & 1
      const iInner = (label >> 1) & 1
      const qInner = label & 1
      const level = (sign: number, inner: number) => ((sign ? -1 : 1) * (inner ? 1 : 3)) / scale
      expect(qam16Slice(level(iSign, iInner), level(qSign, qInner))).toBe(label)
    }
  })

  it('slices every 64QAM label', () => {
    const scale = Math.sqrt(42)
    const level = (sign: number, inner: number, mid: number) => {
      let magnitude = 7
      if (inner === 1 && mid === 0) magnitude = 1
      else if (inner === 1 && mid === 1) magnitude = 3
      else if (inner === 0 && mid === 1) magnitude = 5
      return ((sign ? -1 : 1) * magnitude) / scale
    }
    for (let label = 0; label < 64; label++) {
      const iSign = (label >> 5) & 1
      const qSign = (label >> 4) & 1
      const iInner = (label >> 3) & 1
      const qInner = (label >> 2) & 1
      const iMid = (label >> 1) & 1
      const qMid = label & 1
      expect(qam64Slice(level(iSign, iInner, iMid), level(qSign, qInner, qMid))).toBe(label)
    }
  })
})

describe('bit packing', () => {
  it('reports bits per carrier', () => {
    expect(bitsPerCarrier(CarrierModulation.DQPSK)).toBe(2)
    expect(bitsPerCarrier(CarrierModulation.QPSK)).toBe(2)
    expect(bitsPerCarrier(CarrierModulation.QAM16)).toBe(4)
    expect(bitsPerCarrier(CarrierModulation.QAM64)).toBe(6)
  })

  it('serialises carrier labels most significant bit first', () => {
    const bytes = Uint8Array.from([0b10, 0b01])
    expect(Array.from(serializeCarrierBytes(bytes, 2))).toEqual([1, 0, 0, 1])
  })

  it('packs bits most significant bit first', () => {
    const bits = Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 1])
    expect(Array.from(packBits(bits))).toEqual([0x81])
  })
})
