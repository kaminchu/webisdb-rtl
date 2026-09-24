/**
 * High-level one-seg receive chain: equalized data carriers -> MPEG-TS bytes.
 *
 * This mirrors the reference receiver's FEC chain exactly, per OFDM symbol:
 *   frequency deinterleave -> time deinterleave -> carrier demap ->
 *   bit deinterleave -> streaming depuncture/Viterbi -> byte deinterleave ->
 *   energy descramble -> Reed-Solomon -> TS packet assembly.
 *
 * Time deinterleaving precedes demapping because DQPSK differential detection
 * needs the previous symbol of the same carrier after time deinterleaving.
 * The energy dispersal PRBS is re-initialised every OFDM frame, so the caller
 * must start feeding symbols at a TMCC frame boundary.
 */

import { bitsPerCarrier, type ComplexPlane } from './stages/carrierDemod'
import { EnergyDescrambler, RS_CODEWORD_SIZE, SYNC_BYTE } from './stages/energyDispersal'
import { TsGenerator } from './stages/tsGenerator'
import { demodulatePlaneSoftWasm } from './wasm/demap'
import {
  WasmByteDeinterleaver,
  WasmSoftBitDeinterleaver,
  WasmTimeDeinterleaver,
  frequencyDeinterleaveWasm,
} from './wasm/deinterleave'
import { WasmRsBackend } from './wasm/reedSolomon'
import { WasmStreamingViterbi } from './wasm/viterbi'
import {
  CarrierModulation,
  MODE_PARAMS,
  codeRateName,
  timeInterleaveLength,
  type TransmissionMode,
} from './isdbtParams'
import type { TmccInfo } from '../models/tmcc'
import type { RsBackend } from './backend'

export interface OneSegDecoderOptions {
  rs?: RsBackend
}

const CODE_RATE_FRACTIONS: Record<string, readonly [number, number]> = {
  '1/2': [1, 2],
  '2/3': [2, 3],
  '3/4': [3, 4],
  '5/6': [5, 6],
  '7/8': [7, 8],
}

export class OneSegDecoder {
  readonly mode: TransmissionMode
  readonly modulation: CarrierModulation

  private readonly timeDeinterleaver: WasmTimeDeinterleaver
  private readonly bitDeinterleaver: WasmSoftBitDeinterleaver
  private readonly byteDeinterleaver = new WasmByteDeinterleaver()
  private readonly descrambler = new EnergyDescrambler()
  private readonly ts = new TsGenerator()
  private readonly viterbi: WasmStreamingViterbi
  private readonly rs: RsBackend
  private readonly carriersPerSymbol: number
  private readonly frameBytes: number
  private readonly packet = new Uint8Array(RS_CODEWORD_SIZE)
  private byteIndex = 0
  private previous: ComplexPlane | null = null

  constructor(tmcc: TmccInfo, options: OneSegDecoderOptions = {}) {
    const layer = tmcc.layers.A
    if (tmcc.mode === null || tmcc.mode < 1 || tmcc.mode > 3) {
      throw new Error('one-seg decoder requires a decoded TMCC mode')
    }
    if (layer === null) throw new Error('one-seg decoder requires TMCC layer A')
    this.mode = tmcc.mode as TransmissionMode
    this.modulation = layer.modulation as CarrierModulation
    const codeRate = codeRateName(layer.codeRate)
    this.carriersPerSymbol = MODE_PARAMS[this.mode].dataCarriersPerSegment
    this.timeDeinterleaver = new WasmTimeDeinterleaver(
      this.mode,
      timeInterleaveLength(layer.timeInterleave, this.mode),
    )
    this.bitDeinterleaver = new WasmSoftBitDeinterleaver(this.modulation)
    this.rs = options.rs ?? new WasmRsBackend()
    const [k, n] = CODE_RATE_FRACTIONS[codeRate]
    this.frameBytes = (204 * this.carriersPerSymbol * bitsPerCarrier(this.modulation) * k) / n / 8
    this.viterbi = new WasmStreamingViterbi(codeRate, (byte) => this.pushDecodedByte(byte))
  }

  get tsStats() {
    return this.ts.stats
  }

  reset(): void {
    this.timeDeinterleaver.reset()
    this.bitDeinterleaver.reset()
    this.byteDeinterleaver.reset()
    this.descrambler.reset()
    this.viterbi.reset()
    this.ts.reset()
    this.byteIndex = 0
    this.previous = null
  }

  /** Release the WASM decoder state; the instance must not be used afterwards. */
  dispose(): void {
    this.timeDeinterleaver.destroy()
    this.bitDeinterleaver.destroy()
    this.byteDeinterleaver.destroy()
    this.viterbi.dispose()
  }

  /** Decode a batch of equalized data-carrier planes into MPEG-TS bytes. */
  decode(symbols: readonly ComplexPlane[]): Uint8Array {
    for (const plane of symbols) {
      if (plane.re.length !== this.carriersPerSymbol) {
        throw new Error(`expected ${this.carriersPerSymbol} carriers, got ${plane.re.length}`)
      }
      const deinterleaved = frequencyDeinterleaveWasm(plane, this.mode)
      const td = this.timeDeinterleaver.process(deinterleaved.re, deinterleaved.im)
      if (this.previous === null && this.modulation === CarrierModulation.DQPSK) {
        // Differential reference for the first symbol is the previous frame.
        this.previous = td
        continue
      }
      const soft = demodulatePlaneSoftWasm(this.modulation, td, this.previous)
      this.previous = td
      const deinterleavedBits = this.bitDeinterleaver.process(soft)
      this.viterbi.feedSoftBlock(deinterleavedBits)
    }
    return this.ts.takeBytes()
  }

  private pushDecodedByte(value: number): void {
    const v = this.byteDeinterleaver.processByte(value)
    if (this.byteIndex % this.frameBytes === 0) this.descrambler.reset()
    const mask = this.descrambler.nextMaskByte()
    const offset = this.byteIndex % RS_CODEWORD_SIZE
    if (offset === RS_CODEWORD_SIZE - 1) this.packet[0] = v
    else this.packet[offset + 1] = v ^ mask
    this.byteIndex++
    if (offset === RS_CODEWORD_SIZE - 1) {
      const data = this.rs.decode(this.packet)
      if (data !== null && data[0] === SYNC_BYTE) this.ts.pushBlock(data)
    }
  }
}
