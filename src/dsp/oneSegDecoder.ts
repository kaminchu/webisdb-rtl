/**
 * High-level one-seg receive chain: equalized carriers -> MPEG-TS bytes.
 *
 * Stages, in physical order:
 *   frequency deinterleave -> time deinterleave -> carrier demap ->
 *   bit deinterleave -> depuncture + Viterbi -> byte deinterleave ->
 *   energy descramble -> Reed-Solomon -> TS packet assembly.
 *
 * Time deinterleaving precedes demapping because DQPSK differential detection
 * needs the previous symbol of the same carrier after time deinterleaving.
 * Each stage is exposed separately in `stages/` and can be tested in isolation.
 */

import {
  codeRateName,
  timeInterleaveLength,
  MODE_PARAMS,
  CarrierModulation,
  type TransmissionMode,
} from './isdbtParams'
import type { TmccInfo } from '../models/tmcc'
import type { RsBackend, ViterbiBackend, ViterbiRate } from './backend'
import {
  bitsPerCarrier,
  demodulatePlane,
  demodulatePlaneSoft,
  packBits,
  serializeCarrierBytes,
  type ComplexPlane,
} from './stages/carrierDemod'
import {
  BIT_INTERLEAVER_MAX_DELAY,
  BitDeinterleaver,
  ByteDeinterleaver,
  SoftBitDeinterleaver,
  TimeDeinterleaver,
  frequencyDeinterleave,
} from './stages/deinterleave'
import { EnergyDescrambler, RS_CODEWORD_SIZE } from './stages/energyDispersal'
import { TsRsBackend } from './stages/reedSolomon'
import { TsGenerator } from './stages/tsGenerator'
import { TsViterbiBackend } from './stages/viterbi'

export interface OneSegDecoderOptions {
  /** Enable the 12-branch byte deinterleaver (default false). */
  byteDeinterleave?: boolean
  /** Use soft-decision Viterbi when the backend supports it (default true). */
  softDecision?: boolean
  viterbi?: ViterbiBackend
  rs?: RsBackend
}

export class OneSegDecoder {
  readonly mode: TransmissionMode
  readonly modulation: CarrierModulation
  readonly codeRate: ViterbiRate

  private readonly timeDeinterleaver: TimeDeinterleaver
  private readonly bitDeinterleaver: BitDeinterleaver
  private readonly softBitDeinterleaver: SoftBitDeinterleaver
  private readonly byteDeinterleaver: ByteDeinterleaver | null
  private readonly descrambler = new EnergyDescrambler()
  private readonly ts = new TsGenerator()
  private readonly viterbi: ViterbiBackend
  private readonly rs: RsBackend
  private readonly carriersPerSymbol: number
  private readonly labelBits: number
  private readonly softDecision: boolean
  private pending: number[] = []
  private carrierByteCount = 0

  constructor(tmcc: TmccInfo, options: OneSegDecoderOptions = {}) {
    const layer = tmcc.layers.A
    if (tmcc.mode === null || tmcc.mode < 1 || tmcc.mode > 3) {
      throw new Error('one-seg decoder requires a decoded TMCC mode')
    }
    if (layer === null) throw new Error('one-seg decoder requires TMCC layer A')
    this.mode = tmcc.mode as TransmissionMode
    this.modulation = layer.modulation as CarrierModulation
    this.codeRate = codeRateName(layer.codeRate)
    this.carriersPerSymbol = MODE_PARAMS[this.mode].dataCarriersPerSegment
    this.labelBits = bitsPerCarrier(this.modulation)
    this.timeDeinterleaver = new TimeDeinterleaver(
      this.mode,
      timeInterleaveLength(layer.timeInterleave, this.mode),
    )
    this.bitDeinterleaver = new BitDeinterleaver(this.modulation)
    this.softBitDeinterleaver = new SoftBitDeinterleaver(this.modulation)
    this.byteDeinterleaver = options.byteDeinterleave === true ? new ByteDeinterleaver() : null
    this.viterbi = options.viterbi ?? new TsViterbiBackend()
    this.rs = options.rs ?? new TsRsBackend()
    this.softDecision =
      (options.softDecision ?? true) &&
      typeof this.viterbi.decodeSoft === 'function' &&
      this.modulation === CarrierModulation.QPSK
  }

  get tsStats() {
    return this.ts.stats
  }

  reset(): void {
    this.timeDeinterleaver.reset()
    this.bitDeinterleaver.reset()
    this.softBitDeinterleaver.reset()
    this.byteDeinterleaver?.reset()
    this.descrambler.reset()
    this.ts.reset()
    this.pending = []
    this.carrierByteCount = 0
  }

  /** Decode a batch of equalized carrier planes into MPEG-TS bytes. */
  decode(symbols: readonly ComplexPlane[]): Uint8Array {
    const planes: ComplexPlane[] = []
    for (const plane of symbols) {
      if (plane.re.length !== this.carriersPerSymbol) {
        throw new Error(`expected ${this.carriersPerSymbol} carriers, got ${plane.re.length}`)
      }
      const deinterleaved = frequencyDeinterleave(plane, this.mode)
      planes.push(this.timeDeinterleaver.process(deinterleaved.re, deinterleaved.im))
    }

    const firstData = this.modulation === CarrierModulation.DQPSK ? 1 : 0
    let decoded: Uint8Array
    if (this.softDecision) {
      const soft: number[] = []
      for (let l = firstData; l < planes.length; l++) {
        const prev = l > 0 ? planes[l - 1] : null
        const values = demodulatePlaneSoft(this.modulation, planes[l], prev)
        for (let i = 0; i < values.length; i++) soft.push(values[i])
      }
      const deinterleaved = this.softBitDeinterleaver.process(Int8Array.from(soft))
      const start = this.carrierByteCount
      this.carrierByteCount += Math.floor(deinterleaved.length / this.labelBits)
      const usableStart = Math.max(0, BIT_INTERLEAVER_MAX_DELAY - start) * this.labelBits
      const usable = deinterleaved.subarray(usableStart)
      decoded = this.viterbi.decodeSoft!(usable, this.codeRate, false)
    } else {
      const carrierBytes: number[] = []
      for (let l = firstData; l < planes.length; l++) {
        const prev = l > 0 ? planes[l - 1] : null
        const bytes = demodulatePlane(this.modulation, planes[l], prev)
        for (let i = 0; i < bytes.length; i++) carrierBytes.push(bytes[i])
      }
      const deinterleavedBytes = this.bitDeinterleaver.process(Uint8Array.from(carrierBytes))
      const start = this.carrierByteCount
      this.carrierByteCount += deinterleavedBytes.length
      const usableStart = Math.max(0, BIT_INTERLEAVER_MAX_DELAY - start)
      const usable = deinterleavedBytes.subarray(usableStart)
      const bits = serializeCarrierBytes(usable, this.labelBits)
      decoded = this.viterbi.decode(bits, this.codeRate, false)
    }
    let bytes = packBits(decoded)
    if (this.byteDeinterleaver !== null) bytes = this.byteDeinterleaver.process(bytes)

    for (let i = 0; i < bytes.length; i++) this.pending.push(bytes[i])

    const produced: number[] = []
    while (this.pending.length >= RS_CODEWORD_SIZE) {
      const block = Uint8Array.from(this.pending.splice(0, RS_CODEWORD_SIZE))
      const descrambled = this.descrambler.processBlock(block)
      const data = this.rs.decode(descrambled)
      if (data === null) continue
      this.ts.pushBlock(data)
      const out = this.ts.takeBytes()
      for (let i = 0; i < out.length; i++) produced.push(out[i])
    }
    return Uint8Array.from(produced)
  }
}
