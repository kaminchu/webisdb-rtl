/**
 * Deinterleaving for ISDB-T (ARIB STD-B31).
 *
 * Three independent interleavers are undone here:
 *
 *  - frequency (carrier) deinterleaving, per segment, using the ARIB
 *    `d_random_perm` carrier permutation plus the per-segment carrier rotation;
 *  - bit deinterleaving, a per-carrier shift register that delays each
 *    constellation label bit by a fixed number of carrier symbols;
 *  - time deinterleaving, a convolutional (Ramsey) interleaver over the data
 *    carriers with unit delay I;
 *  - byte deinterleaving, the 12-branch convolutional byte interleaver.
 *
 * The one-seg (partial reception) center segment is not inter-segment
 * interleaved, so only the intra-segment permutation is applied to it.
 */

import { MODE_PARAMS, type TransmissionMode, CarrierModulation } from '../isdbtParams'
import type { ComplexPlane } from './carrierDemod'

/** Carrier permutation for Mode 1 (96 data carriers per segment). */
export const FREQ_PERM_MODE1: readonly number[] = [
  80, 93, 63, 92, 94, 55, 17, 81, 6, 51, 9, 85, 89, 65, 52, 15, 73, 66, 46, 71, 12, 70, 18, 13, 95,
  34, 1, 38, 78, 59, 91, 64, 0, 28, 11, 4, 45, 35, 16, 7, 48, 22, 23, 77, 56, 19, 8, 36, 39, 61, 21,
  3, 26, 69, 67, 20, 74, 86, 72, 25, 31, 5, 49, 42, 54, 87, 43, 60, 29, 2, 76, 84, 83, 40, 14, 79,
  27, 57, 44, 37, 30, 68, 47, 88, 75, 41, 90, 10, 33, 32, 62, 50, 58, 82, 53, 24,
]

/** Carrier permutation for Mode 2 (192 data carriers per segment). */
export const FREQ_PERM_MODE2: readonly number[] = [
  98, 35, 67, 116, 135, 17, 5, 93, 73, 168, 54, 143, 43, 74, 165, 48, 37, 69, 154, 150, 107, 76,
  176, 79, 175, 36, 28, 78, 47, 128, 94, 163, 184, 72, 142, 2, 86, 14, 130, 151, 114, 68, 46, 183,
  122, 112, 180, 42, 105, 97, 33, 134, 177, 84, 170, 45, 187, 38, 167, 10, 189, 51, 117, 156, 161,
  25, 89, 125, 139, 24, 19, 57, 71, 39, 77, 191, 88, 85, 0, 162, 181, 113, 140, 61, 75, 82, 101,
  174, 118, 20, 136, 3, 121, 190, 120, 92, 160, 52, 153, 127, 65, 60, 133, 147, 131, 87, 22, 58,
  100, 111, 141, 83, 49, 132, 12, 155, 146, 102, 164, 66, 1, 62, 178, 15, 182, 96, 80, 119, 23, 6,
  166, 56, 99, 123, 138, 137, 21, 145, 185, 18, 70, 129, 95, 90, 149, 109, 124, 50, 11, 152, 4, 31,
  172, 40, 13, 32, 55, 159, 41, 8, 7, 144, 16, 26, 173, 81, 44, 103, 64, 9, 30, 157, 126, 179, 148,
  63, 188, 171, 106, 104, 158, 115, 34, 186, 29, 108, 53, 91, 169, 110, 27, 59,
]

/** Carrier permutation for Mode 3 (384 data carriers per segment). */
export const FREQ_PERM_MODE3: readonly number[] = [
  62, 13, 371, 11, 285, 336, 365, 220, 226, 92, 56, 46, 120, 175, 298, 352, 172, 235, 53, 164, 368,
  187, 125, 82, 5, 45, 173, 258, 135, 182, 141, 273, 126, 264, 286, 88, 233, 61, 249, 367, 310, 179,
  155, 57, 123, 208, 14, 227, 100, 311, 205, 79, 184, 185, 328, 77, 115, 277, 112, 20, 199, 178,
  143, 152, 215, 204, 139, 234, 358, 192, 309, 183, 81, 129, 256, 314, 101, 43, 97, 324, 142, 157,
  90, 214, 102, 29, 303, 363, 261, 31, 22, 52, 305, 301, 293, 177, 116, 296, 85, 196, 191, 114, 58,
  198, 16, 167, 145, 119, 245, 113, 295, 193, 232, 17, 108, 283, 246, 64, 237, 189, 128, 373, 302,
  320, 239, 335, 356, 39, 347, 351, 73, 158, 276, 243, 99, 38, 287, 3, 330, 153, 315, 117, 289, 213,
  210, 149, 383, 337, 339, 151, 241, 321, 217, 30, 334, 161, 322, 49, 176, 359, 12, 346, 60, 28,
  229, 265, 288, 225, 382, 59, 181, 170, 319, 341, 86, 251, 133, 344, 361, 109, 44, 369, 268, 257,
  323, 55, 317, 381, 121, 360, 260, 275, 190, 19, 63, 18, 248, 9, 240, 211, 150, 230, 332, 231, 71,
  255, 350, 355, 83, 87, 154, 218, 138, 269, 348, 130, 160, 278, 377, 216, 236, 308, 223, 254, 25,
  98, 300, 201, 137, 219, 36, 325, 124, 66, 353, 169, 21, 35, 107, 50, 106, 333, 326, 262, 252, 271,
  263, 372, 136, 0, 366, 206, 159, 122, 188, 6, 284, 96, 26, 200, 197, 186, 345, 340, 349, 103, 84,
  228, 212, 2, 67, 318, 1, 74, 342, 166, 194, 33, 68, 267, 111, 118, 140, 195, 105, 202, 291, 259,
  23, 171, 65, 281, 24, 165, 8, 94, 222, 331, 34, 238, 364, 376, 266, 89, 80, 253, 163, 280, 247, 4,
  362, 379, 290, 279, 54, 78, 180, 72, 316, 282, 131, 207, 343, 370, 306, 221, 132, 7, 148, 299,
  168, 224, 48, 47, 357, 313, 75, 104, 70, 147, 40, 110, 374, 69, 146, 37, 375, 354, 174, 41, 32,
  304, 307, 312, 15, 272, 134, 242, 203, 209, 380, 162, 297, 327, 10, 93, 42, 250, 156, 338, 292,
  144, 378, 294, 329, 127, 270, 76, 95, 91, 244, 274, 27, 51,
]

export function frequencyPermutation(mode: TransmissionMode): readonly number[] {
  switch (mode) {
    case 1:
      return FREQ_PERM_MODE1
    case 2:
      return FREQ_PERM_MODE2
    default:
      return FREQ_PERM_MODE3
  }
}

/**
 * Undo the intra-segment frequency interleaving.
 *
 * `rotation` is the per-segment carrier rotation (0 for the one-seg center
 * segment). The input plane must contain exactly the segment's data carriers.
 */
export function frequencyDeinterleave(
  plane: ComplexPlane,
  mode: TransmissionMode,
  rotation = 0,
): ComplexPlane {
  const perm = frequencyPermutation(mode)
  const size = perm.length
  const n = plane.re.length
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const src = perm[(((k - rotation) % size) + size) % size]
    re[k] = plane.re[src]
    im[k] = plane.im[src]
  }
  return { re, im }
}

/** Inverse of `frequencyDeinterleave`; used by tests and the transmit side. */
export function frequencyInterleave(
  plane: ComplexPlane,
  mode: TransmissionMode,
  rotation = 0,
): ComplexPlane {
  const perm = frequencyPermutation(mode)
  const size = perm.length
  const n = plane.re.length
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    const dst = perm[(((k - rotation) % size) + size) % size]
    re[dst] = plane.re[k]
    im[dst] = plane.im[k]
  }
  return { re, im }
}

/**
 * Per-label-bit delays. The I (first) bit is delayed by 120 carrier symbols and
 * the Q (second) bit is not delayed, matching the inner coder's G1/G2 order.
 */
const BIT_DELAY_QPSK: readonly number[] = [120, 0]
const BIT_DELAY_QAM16: readonly number[] = [120, 80, 40, 0]
const BIT_DELAY_QAM64: readonly number[] = [120, 96, 72, 48, 24, 0]

/** Largest bit deinterleaver delay, in carrier symbols. */
export const BIT_INTERLEAVER_MAX_DELAY = 120

/** Per-label-bit delays applied by the bit deinterleaver. */
export function bitDeinterleaveDelays(modulation: CarrierModulation): readonly number[] {
  switch (modulation) {
    case CarrierModulation.QPSK:
    case CarrierModulation.DQPSK:
      return BIT_DELAY_QPSK
    case CarrierModulation.QAM16:
      return BIT_DELAY_QAM16
    default:
      return BIT_DELAY_QAM64
  }
}

/**
 * Per-carrier bit deinterleaver.
 *
 * Label bit `b` of the output at carrier-stream position t is taken from label
 * bit `b` of the input at position `t - delays[b]`. The stream is the
 * concatenation of every OFDM symbol's carrier labels, so a single history of
 * 121 carrier bytes is enough for all bit planes.
 */
export class BitDeinterleaver {
  private readonly delays: readonly number[]
  private readonly history: Uint8Array
  private pos = 0

  constructor(modulation: CarrierModulation) {
    this.delays = bitDeinterleaveDelays(modulation)
    this.history = new Uint8Array(BIT_INTERLEAVER_MAX_DELAY + 1)
  }

  reset(): void {
    this.history.fill(0)
    this.pos = 0
  }

  process(symbols: Uint8Array): Uint8Array {
    const out = new Uint8Array(symbols.length)
    const size = this.history.length
    for (let i = 0; i < symbols.length; i++) {
      this.history[this.pos] = symbols[i]
      let value = 0
      for (let b = 0; b < this.delays.length; b++) {
        const idx = (this.pos - this.delays[b] + size) % size
        value |= ((this.history[idx] >> b) & 1) << b
      }
      out[i] = value
      this.pos = (this.pos + 1) % size
    }
    return out
  }
}

/**
 * Soft per-carrier bit deinterleaver: same delays as `BitDeinterleaver` but
 * operating on soft (signed) values, most significant label bit first.
 */
export class SoftBitDeinterleaver {
  private readonly delays: readonly number[]
  private readonly labelBits: number
  private readonly history: Int8Array
  private pos = 0

  constructor(modulation: CarrierModulation) {
    this.delays = bitDeinterleaveDelays(modulation)
    this.labelBits = this.delays.length
    this.history = new Int8Array((BIT_INTERLEAVER_MAX_DELAY + 1) * this.labelBits)
  }

  reset(): void {
    this.history.fill(0)
    this.pos = 0
  }

  process(input: Int8Array): Int8Array {
    const out = new Int8Array(input.length)
    const size = BIT_INTERLEAVER_MAX_DELAY + 1
    const carriers = Math.floor(input.length / this.labelBits)
    for (let t = 0; t < carriers; t++) {
      for (let b = 0; b < this.labelBits; b++) {
        this.history[this.pos * this.labelBits + b] = input[t * this.labelBits + b]
      }
      for (let b = 0; b < this.labelBits; b++) {
        const idx = (this.pos - this.delays[b] + size) % size
        out[t * this.labelBits + b] = this.history[idx * this.labelBits + b]
      }
      this.pos = (this.pos + 1) % size
    }
    return out
  }
}

/**
 * Convolutional (Ramsey) time deinterleaver over the data carriers.
 *
 * Branch c uses `mi = (5*c) mod 96` and a FIFO of depth `I*(95-mi)+1`, so the
 * output for branch c lags its input by `I*(95-mi)` symbols. With `I = 0` the
 * deinterleaver is a pass-through.
 */
export class TimeDeinterleaver {
  private readonly I: number
  private readonly carriers: number
  private readonly depth: Int32Array
  private readonly reBuf: Float32Array[]
  private readonly imBuf: Float32Array[]
  private readonly pos: Int32Array

  constructor(mode: TransmissionMode, I: number) {
    this.I = I
    this.carriers = MODE_PARAMS[mode].dataCarriersPerSegment
    this.depth = new Int32Array(this.carriers)
    this.pos = new Int32Array(this.carriers)
    this.reBuf = []
    this.imBuf = []
    for (let c = 0; c < this.carriers; c++) {
      const mi = (5 * c) % 96
      const depth = I * (95 - mi) + 1
      this.depth[c] = depth
      this.reBuf[c] = new Float32Array(depth)
      this.imBuf[c] = new Float32Array(depth)
    }
  }

  reset(): void {
    for (let c = 0; c < this.carriers; c++) {
      this.reBuf[c].fill(0)
      this.imBuf[c].fill(0)
      this.pos[c] = 0
    }
  }

  process(re: Float32Array, im: Float32Array): ComplexPlane {
    const n = this.carriers
    const outRe = new Float32Array(n)
    const outIm = new Float32Array(n)
    if (this.I === 0) {
      outRe.set(re.subarray(0, n))
      outIm.set(im.subarray(0, n))
      return { re: outRe, im: outIm }
    }
    for (let c = 0; c < n; c++) {
      const depth = this.depth[c]
      const p = this.pos[c]
      const read = (p + 1) % depth
      this.reBuf[c][p] = re[c]
      this.imBuf[c][p] = im[c]
      outRe[c] = this.reBuf[c][read]
      outIm[c] = this.imBuf[c][read]
      this.pos[c] = read
    }
    return { re: outRe, im: outIm }
  }
}

/** Number of branches of the byte interleaver. */
export const BYTE_INTERLEAVER_BRANCHES = 12
/** Branch delay increment of the byte interleaver. */
export const BYTE_INTERLEAVER_M = 17

/**
 * 12-branch convolutional byte deinterleaver.
 *
 * Branch `n mod 12` uses a FIFO of `1 + 17*(11 - n mod 12)` bytes. The
 * transmitter's extra "delay adjustment" branch and frame alignment are not
 * modelled; they only shift the output stream by a constant number of bytes.
 */
export class ByteDeinterleaver {
  private readonly buffers: Uint8Array[]
  private readonly pos: Int32Array
  private index = 0

  constructor() {
    this.buffers = []
    this.pos = new Int32Array(BYTE_INTERLEAVER_BRANCHES)
    for (let b = 0; b < BYTE_INTERLEAVER_BRANCHES; b++) {
      this.buffers[b] = new Uint8Array(1 + BYTE_INTERLEAVER_M * (BYTE_INTERLEAVER_BRANCHES - 1 - b))
    }
  }

  reset(): void {
    for (const buf of this.buffers) buf.fill(0)
    this.pos.fill(0)
    this.index = 0
  }

  process(input: Uint8Array): Uint8Array {
    const out = new Uint8Array(input.length)
    for (let i = 0; i < input.length; i++) out[i] = this.processByte(input[i])
    return out
  }

  /** Push one byte through the branch selected by the running byte index. */
  processByte(value: number): number {
    const b = this.index % BYTE_INTERLEAVER_BRANCHES
    const buf = this.buffers[b]
    const size = buf.length
    const p = this.pos[b]
    buf[p] = value
    const out = buf[(p + 1) % size]
    this.pos[b] = (p + 1) % size
    this.index++
    return out
  }
}
