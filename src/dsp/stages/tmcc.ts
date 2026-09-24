/**
 * TMCC (Transmission and Multiplexing Configuration Control) decoding.
 *
 * Layout per ARIB STD-B31 Table 3-20 / 3-22 (B0 = differential reference):
 *  - B1-B16   frame synchronising signal (w0/w1, alternating each frame)
 *  - B17-B19  segment-type identification (111 differential / 000 synchronous)
 *  - B20-B121 TMCC information (102 bits): system id, parameter-switch indicator,
 *             emergency flag, partial-reception flag, current/next layers A/B/C
 *  - B122-B203 DSC parity (shortened (184,102) code of the (273,191) DSC code)
 *
 * The transmission mode is NOT carried in TMCC; it is determined from the OFDM
 * carrier spacing, so `mode` and `guardIntervalRatio` are supplied by the caller.
 *
 * Implemented:
 *  - 204-bit frame buffering with 16-bit frame-sync phase search over all offsets.
 *  - DBPSK in the time direction on each one-seg TMCC carrier, majority-voted.
 *  - Per-frame soft (+/-1) majority accumulation across frames.
 *  - Field extraction (system id, partial reception, layers A/B/C) and DSC parity
 *    syndrome (error count only; no correction).
 *
 * Not implemented: next-information fields, phase-shift correction, reserved bits.
 *
 * `locked` is asserted after two consecutive majority frames decode to the same
 * configuration.
 */

import { MODE_PARAMS, type TransmissionMode } from '../isdbtParams'
import type { TmccInfo, TmccLayerInfo } from '../../models/tmcc'

export const TMCC_BITS_PER_FRAME = 204
const SYNC_BITS = 16

const SYNC_EVEN = [0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0] as const
const SYNC_ODD = [1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1] as const

/** Offset of the TMCC information / codeword from the sync start (B20). */
const INFO_OFFSET = 19

/** Check polynomial h(x) of the (273,191) difference-set cyclic code (192 taps). */
const DSC_CHECK_POLY = Uint8Array.from([
  1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0,
  0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0,
  1, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1,
  1, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0,
  0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0,
  1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1,
])

function bitsToInt(bits: Uint8Array, start: number, length: number): number {
  let v = 0
  for (let i = 0; i < length; i++) v = (v << 1) | bits[start + i]
  return v
}

/** Hamming distances from the 16 bits at `offset` to the even/odd sync words. */
export function syncDistance(bits: ArrayLike<number>, offset = 0): { even: number; odd: number } {
  let even = 0
  let odd = 0
  for (let i = 0; i < SYNC_BITS; i++) {
    const b = bits[offset + i]
    if (b !== SYNC_EVEN[i]) even++
    if (b !== SYNC_ODD[i]) odd++
  }
  return { even, odd }
}

/** Compare the 16 bits at `offset` with the even/odd frame sync words. 0 = none. */
export function matchSyncWord(bits: ArrayLike<number>, offset = 0): 0 | 1 | 2 {
  const { even, odd } = syncDistance(bits, offset)
  if (even === 0) return 1
  if (odd === 0) return 2
  return 0
}

/** Maximum Hamming distance accepted when locating the sync word in the stream. */
const SYNC_TOLERANCE = 2

/** Bits buffered before scoring frame-phase hypotheses (two frames plus a sync). */
const PHASE_SEARCH_BITS = 2 * TMCC_BITS_PER_FRAME + SYNC_BITS

function minSyncDistance(bits: ArrayLike<number>, offset = 0): number {
  const { even, odd } = syncDistance(bits, offset)
  return Math.min(even, odd)
}

/**
 * Count non-zero syndrome bits of the shortened (184,102) DSC code. The 184-bit
 * codeword is placed after 89 zeros to form the full 273-bit block. Zero means
 * the frame is a valid codeword.
 */
export function dscSyndromeCount(codeword184: Uint8Array): number {
  const block = new Uint8Array(273)
  block.set(codeword184.subarray(0, 184), 89)
  let errors = 0
  for (let j = 0; j < 82; j++) {
    let s = 0
    for (let i = 0; i < 192; i++) s ^= block[i + j] & DSC_CHECK_POLY[i]
    if (s !== 0) errors++
  }
  return errors
}

function decodeLayer(bits: Uint8Array, start: number): TmccLayerInfo | null {
  const modulation = bitsToInt(bits, start, 3)
  const codeRate = bitsToInt(bits, start + 3, 3)
  const timeInterleave = bitsToInt(bits, start + 6, 3)
  const segments = bitsToInt(bits, start + 9, 4)
  if (modulation === 7 || segments === 0) return null
  return { modulation, codeRate, timeInterleave, segments }
}

/**
 * Decode one 204-bit TMCC frame. `bits[i]` holds bit B(i+1): sync at 0..15,
 * segment-type id at 16..18, information at 19..120, parity at 121..202.
 *
 * `mode` and `guardIntervalRatio` are not carried in TMCC and are passed in from
 * the synchronizer.
 */
export function decodeTmccBits(
  bits: Uint8Array,
  mode: number | null = null,
  guardIntervalRatio: number | null = null,
): TmccInfo {
  const parityErrors = dscSyndromeCount(bits.subarray(INFO_OFFSET, INFO_OFFSET + 184))
  return {
    locked: matchSyncWord(bits) !== 0 && parityErrors === 0,
    mode,
    guardIntervalRatio,
    partialReception: bits[26] === 1,
    systemDescriptor: bitsToInt(bits, INFO_OFFSET, 2),
    layers: {
      A: decodeLayer(bits, 27),
      B: decodeLayer(bits, 40),
      C: decodeLayer(bits, 53),
    },
    frameCount: 1,
    rawBits: bits.slice(),
  }
}

function layerKey(l: TmccLayerInfo | null): string {
  return l ? `${l.modulation}/${l.codeRate}/${l.timeInterleave}/${l.segments}` : '-'
}

function consistencyKey(info: TmccInfo): string {
  return [
    info.mode,
    info.systemDescriptor,
    info.partialReception ? 1 : 0,
    layerKey(info.layers.A),
    layerKey(info.layers.B),
    layerKey(info.layers.C),
  ].join('|')
}

function emptyInfo(mode: number | null, giRatio: number | null): TmccInfo {
  return {
    locked: false,
    mode,
    guardIntervalRatio: giRatio,
    partialReception: false,
    systemDescriptor: null,
    layers: { A: null, B: null, C: null },
    frameCount: 0,
  }
}

/**
 * Streaming TMCC decoder. Feed the one-seg TMCC carrier values (complex) of each
 * OFDM symbol via `push`; the returned `TmccInfo` reflects the latest state.
 *
 * Bit decisions are DBPSK in the time direction and majority-voted across the
 * one-seg TMCC carriers. Frame phase is acquired by scoring all 204 possible
 * frame offsets against the sync word over at least two frames (a single false
 * sync match cannot lock the phase). Each frame position is then accumulated
 * with a soft (+/-1) vote across frames and decoded by majority, which makes a
 * lock possible with only 1-4 TMCC carriers on a noisy real capture. `locked` is
 * asserted after two consecutive majority frames decode to the same config.
 */
export class TmccDecoder {
  private readonly mode: TransmissionMode
  private readonly giRatio: number | null
  private readonly carriers: number
  private readonly prevRe: Float32Array
  private readonly prevIm: Float32Array
  private havePrev = false
  private phaseSearch: number[] = []
  private phasePos = -1
  private totalBits = 0
  private frameStartBit = -1
  private readonly accum = new Int16Array(TMCC_BITS_PER_FRAME)
  private readonly frame = new Uint8Array(TMCC_BITS_PER_FRAME)
  private accumFrames = 0
  private locked = false
  private consistent = 0
  private lastKey = ''
  private lastInfo: TmccInfo

  constructor(mode: TransmissionMode, giRatio: number | null = null) {
    this.mode = mode
    this.giRatio = giRatio
    this.carriers = MODE_PARAMS[mode].tmccPerSegment
    this.prevRe = new Float32Array(this.carriers)
    this.prevIm = new Float32Array(this.carriers)
    this.lastInfo = emptyInfo(mode, giRatio)
  }

  reset(): void {
    this.havePrev = false
    this.phaseSearch = []
    this.phasePos = -1
    this.totalBits = 0
    this.frameStartBit = -1
    this.accum.fill(0)
    this.accumFrames = 0
    this.locked = false
    this.consistent = 0
    this.lastKey = ''
    this.lastInfo = emptyInfo(this.mode, this.giRatio)
  }

  /** 0-based symbol index of the current frame's B1, or -1 if not phase-locked. */
  get frameStartSymbol(): number {
    return this.frameStartBit < 0 ? -1 : this.frameStartBit + 1
  }

  push(re: Float32Array, im: Float32Array): TmccInfo {
    if (!this.havePrev) {
      this.prevRe.set(re.subarray(0, this.carriers))
      this.prevIm.set(im.subarray(0, this.carriers))
      this.havePrev = true
      return this.lastInfo
    }
    let vote = 0
    for (let k = 0; k < this.carriers; k++) {
      const dr = re[k] * this.prevRe[k] + im[k] * this.prevIm[k]
      vote += dr >= 0 ? 1 : -1
      this.prevRe[k] = re[k]
      this.prevIm[k] = im[k]
    }
    return this.feedBit(vote >= 0 ? 0 : 1)
  }

  private feedBit(bit: number): TmccInfo {
    this.totalBits++
    if (this.phasePos < 0) {
      this.phaseSearch.push(bit)
      if (this.phaseSearch.length >= PHASE_SEARCH_BITS) this.acquirePhase()
      return this.lastInfo
    }

    this.frame[this.phasePos] = bit
    this.phasePos++
    if (this.phasePos >= TMCC_BITS_PER_FRAME) {
      this.phasePos = 0
      this.accumulateFrame(this.frame)
      this.accumFrames++
      if (this.accumFrames > 1000) for (let i = 0; i < this.accum.length; i++) this.accum[i] >>= 1
      return this.decodeAccumulated()
    }
    return this.lastInfo
  }

  private accumulateFrame(frame: ArrayLike<number>): void {
    const distance = syncDistance(frame)
    for (let i = 0; i < TMCC_BITS_PER_FRAME; i++) {
      const bit = i < SYNC_BITS && distance.odd < distance.even ? frame[i] ^ 1 : frame[i]
      this.accum[i] += bit ? 1 : -1
    }
  }

  private acquirePhase(): void {
    const buf = this.phaseSearch
    const len = buf.length
    let best = -1
    let bestAvg = -1
    let bestCount = 0
    for (let p = 0; p < TMCC_BITS_PER_FRAME; p++) {
      let score = 0
      let count = 0
      for (let q = p; q + SYNC_BITS <= len; q += TMCC_BITS_PER_FRAME) {
        score += SYNC_BITS - minSyncDistance(buf, q)
        count++
      }
      if (count < 2) continue
      const avg = score / count
      if (avg > bestAvg || (avg === bestAvg && count > bestCount)) {
        bestAvg = avg
        best = p
        bestCount = count
      }
    }
    if (best < 0 || bestAvg < 12) {
      const cap = 4 * TMCC_BITS_PER_FRAME + SYNC_BITS
      if (buf.length > cap) buf.splice(0, buf.length - cap)
      return
    }

    this.accum.fill(0)
    const run = len - best
    this.frameStartBit = this.totalBits - len + best
    this.accumFrames = Math.floor(run / TMCC_BITS_PER_FRAME)
    for (let i = 0; i < this.accumFrames; i++) {
      this.accumulateFrame(
        buf.slice(best + i * TMCC_BITS_PER_FRAME, best + (i + 1) * TMCC_BITS_PER_FRAME),
      )
    }
    this.phasePos = run % TMCC_BITS_PER_FRAME
    this.frame.set(buf.slice(best + this.accumFrames * TMCC_BITS_PER_FRAME))
    this.phaseSearch = []
    this.consistent = 0
    this.lastKey = ''
    if (this.accumFrames >= 1) this.decodeAccumulated()
  }

  private decodeAccumulated(): TmccInfo {
    const bits = new Uint8Array(TMCC_BITS_PER_FRAME)
    for (let i = 0; i < bits.length; i++) bits[i] = this.accum[i] > 0 ? 1 : 0
    if (minSyncDistance(bits) > SYNC_TOLERANCE + 2) {
      this.phasePos = -1
      this.phaseSearch = []
      this.accum.fill(0)
      this.accumFrames = 0
      this.consistent = 0
      this.lastKey = ''
      this.locked = false
      this.lastInfo = { ...this.lastInfo, locked: false }
      return this.lastInfo
    }
    const info = decodeTmccBits(bits, this.mode, this.giRatio)
    if (!info.locked) {
      this.consistent = 0
      this.locked = false
      this.lastInfo = { ...info, locked: false, frameCount: this.accumFrames }
      return this.lastInfo
    }
    const key = consistencyKey(info)
    if (key === this.lastKey) this.consistent++
    else this.consistent = 1
    this.lastKey = key
    if (this.consistent >= 2) this.locked = true
    this.lastInfo = { ...info, locked: this.locked, frameCount: this.accumFrames }
    return this.lastInfo
  }
}
