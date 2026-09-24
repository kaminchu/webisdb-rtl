/**
 * Carrier demapping for ISDB-T layers (ARIB STD-B31).
 *
 * Layer A of one-seg is normally DQPSK, differentially encoded in the time
 * direction. The decision variable for carrier k at symbol l is
 *
 *   d_l[k] = Z_l[k] * conj(Z_{l-1}[k])
 *
 * and its argument is quantised to one of four Gray-coded pi/2 steps. Coherent
 * QPSK/16QAM/64QAM slicers are provided for the higher layers.
 *
 * Each slicer returns one carrier byte whose low `bitsPerCarrier` bits are the
 * constellation label, most significant label bit first. `serializeCarrierBytes`
 * flattens those labels into a plain bit stream for the convolutional decoder.
 */

import { CarrierModulation } from '../isdbtParams'

export interface ComplexPlane {
  readonly re: Float32Array
  readonly im: Float32Array
}

/** Phase step of the Gray-coded DQPSK constellation. */
export const DQPSK_PHASE_STEP = Math.PI / 2

const QAM16_NORM = Math.sqrt(10)
const QAM64_NORM = Math.sqrt(42)

/** Number of bits carried by one carrier for a given modulation. */
export function bitsPerCarrier(modulation: CarrierModulation): number {
  switch (modulation) {
    case CarrierModulation.QPSK:
    case CarrierModulation.DQPSK:
      return 2
    case CarrierModulation.QAM16:
      return 4
    default:
      return 6
  }
}

/** Differential phase (radians) between two equal-length carrier planes. */
export function dqpskDifferentialPhase(prev: ComplexPlane, curr: ComplexPlane): Float32Array {
  const n = Math.min(prev.re.length, curr.re.length)
  const out = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const pr = prev.re[k]
    const pi = prev.im[k]
    const cr = curr.re[k]
    const ci = curr.im[k]
    out[k] = Math.atan2(ci * pr - cr * pi, cr * pr + ci * pi)
  }
  return out
}

/**
 * Quantise a differential phase to a 2-bit Gray label.
 * 0 -> 00, pi/2 -> 01, pi -> 11, 3pi/2 -> 10.
 */
export function dqpskSlice(delta: number): number {
  const twoPi = Math.PI * 2
  const wrapped = ((delta % twoPi) + twoPi) % twoPi
  const index = Math.floor((wrapped + DQPSK_PHASE_STEP / 2) / DQPSK_PHASE_STEP) % 4
  return index ^ (index >> 1)
}

/** Coherent QPSK slicer. Carriers are assumed normalised by 1/sqrt(2). */
export function qpskSlice(re: number, im: number): number {
  return ((re < 0 ? 1 : 0) << 1) | (im < 0 ? 1 : 0)
}

/** Coherent 16QAM slicer. Carriers are assumed normalised by 1/sqrt(10). */
export function qam16Slice(re: number, im: number): number {
  const threshold = 2 / QAM16_NORM
  return (
    ((re < 0 ? 1 : 0) << 3) |
    ((im < 0 ? 1 : 0) << 2) |
    ((Math.abs(re) < threshold ? 1 : 0) << 1) |
    (Math.abs(im) < threshold ? 1 : 0)
  )
}

/** Coherent 64QAM slicer. Carriers are assumed normalised by 1/sqrt(42). */
export function qam64Slice(re: number, im: number): number {
  const threshold = 2 / QAM64_NORM
  const ar = Math.abs(re)
  const ai = Math.abs(im)
  return (
    ((re < 0 ? 1 : 0) << 5) |
    ((im < 0 ? 1 : 0) << 4) |
    ((ar < 2 * threshold ? 1 : 0) << 3) |
    ((ai < 2 * threshold ? 1 : 0) << 2) |
    ((ar > threshold && ar < 3 * threshold ? 1 : 0) << 1) |
    (ai > threshold && ai < 3 * threshold ? 1 : 0)
  )
}

/**
 * Demap a carrier plane to one byte per carrier.
 *
 * DQPSK needs the previous symbol plane; the other modulations ignore it.
 */
export function demodulatePlane(
  modulation: CarrierModulation,
  curr: ComplexPlane,
  prev: ComplexPlane | null,
): Uint8Array {
  const n = curr.re.length
  const out = new Uint8Array(n)
  switch (modulation) {
    case CarrierModulation.DQPSK: {
      if (prev === null) {
        throw new Error('DQPSK demodulation requires the previous symbol plane')
      }
      const delta = dqpskDifferentialPhase(prev, curr)
      for (let k = 0; k < n; k++) out[k] = dqpskSlice(delta[k])
      return out
    }
    case CarrierModulation.QPSK:
      for (let k = 0; k < n; k++) out[k] = qpskSlice(curr.re[k], curr.im[k])
      return out
    case CarrierModulation.QAM16:
      for (let k = 0; k < n; k++) out[k] = qam16Slice(curr.re[k], curr.im[k])
      return out
    default:
      for (let k = 0; k < n; k++) out[k] = qam64Slice(curr.re[k], curr.im[k])
      return out
  }
}

/** Flatten carrier labels into bits, most significant label bit first. */
export function serializeCarrierBytes(bytes: Uint8Array, bits: number): Uint8Array {
  const out = new Uint8Array(bytes.length * bits)
  let o = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    for (let j = bits - 1; j >= 0; j--) out[o++] = (b >> j) & 1
  }
  return out
}

function clampSoft(value: number): number {
  const v = Math.round(value * 64)
  return v > 127 ? 127 : v < -127 ? -127 : v
}

/**
 * Soft-demap a carrier plane into `bitsPerCarrier` soft values per carrier,
 * most significant label bit first. Positive means label bit 0. Only QPSK and
 * DQPSK (one-seg layer A) are soft; higher-order QAM falls back to hard +/-127.
 */
export function demodulatePlaneSoft(
  modulation: CarrierModulation,
  curr: ComplexPlane,
  prev: ComplexPlane | null,
): Int8Array {
  const n = curr.re.length
  if (modulation === CarrierModulation.QPSK) {
    const out = new Int8Array(n * 2)
    for (let k = 0; k < n; k++) {
      out[2 * k] = clampSoft(curr.re[k])
      out[2 * k + 1] = clampSoft(curr.im[k])
    }
    return out
  }
  if (modulation === CarrierModulation.DQPSK && prev !== null) {
    const out = new Int8Array(n * 2)
    for (let k = 0; k < n; k++) {
      const dr = curr.re[k] * prev.re[k] + curr.im[k] * prev.im[k]
      const di = curr.im[k] * prev.re[k] - curr.re[k] * prev.im[k]
      out[2 * k] = clampSoft(dr)
      out[2 * k + 1] = clampSoft(-di)
    }
    return out
  }
  const hard = demodulatePlane(modulation, curr, prev)
  const bits = bitsPerCarrier(modulation)
  const out = new Int8Array(n * bits)
  let o = 0
  for (let i = 0; i < n; i++) {
    const b = hard[i]
    for (let j = bits - 1; j >= 0; j--) out[o++] = ((b >> j) & 1) === 0 ? 127 : -127
  }
  return out
}

/** Pack a bit stream into bytes, most significant bit first. */
export function packBits(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(bits.length >>> 3)
  for (let i = 0; i < out.length; i++) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] & 1)
    out[i] = b
  }
  return out
}
