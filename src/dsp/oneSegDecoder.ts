/**
 * High-level one-seg receive chain: equalized data carriers -> MPEG-TS bytes.
 *
 * The FEC chain (frequency/time deinterleave -> soft demap -> bit deinterleave
 * -> streaming Viterbi -> byte deinterleave -> energy descramble ->
 * Reed-Solomon -> TS assembly) runs inside the fused `oneseg` WASM kernel so a
 * whole symbol batch stays in linear memory; see `wasm/dsp/src/oneseg.rs`.
 *
 * Time deinterleaving precedes demapping because DQPSK differential detection
 * needs the previous symbol of the same carrier after time deinterleaving.
 * The energy dispersal PRBS is re-initialised every OFDM frame, so the caller
 * must start feeding symbols at a TMCC frame boundary.
 */

import { bitsPerCarrier, type ComplexPlane } from './stages/carrierDemod'
import {
  CarrierModulation,
  MODE_PARAMS,
  codeRateName,
  timeInterleaveLength,
  type TransmissionMode,
} from './isdbtParams'
import type { TmccInfo } from '../models/tmcc'
import { WasmOneSegDecoder } from './wasm/oneseg'

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

  private readonly carriersPerSymbol: number
  private readonly decoder: WasmOneSegDecoder

  constructor(tmcc: TmccInfo) {
    const layer = tmcc.layers.A
    if (tmcc.mode === null || tmcc.mode < 1 || tmcc.mode > 3) {
      throw new Error('one-seg decoder requires a decoded TMCC mode')
    }
    if (layer === null) throw new Error('one-seg decoder requires TMCC layer A')
    this.mode = tmcc.mode as TransmissionMode
    this.modulation = layer.modulation as CarrierModulation
    const codeRate = codeRateName(layer.codeRate)
    this.carriersPerSymbol = MODE_PARAMS[this.mode].dataCarriersPerSegment
    const [k, n] = CODE_RATE_FRACTIONS[codeRate]
    const frameBytes = (204 * this.carriersPerSymbol * bitsPerCarrier(this.modulation) * k) / n / 8
    this.decoder = new WasmOneSegDecoder(
      this.mode,
      this.modulation,
      codeRate,
      timeInterleaveLength(layer.timeInterleave, this.mode),
      Math.round(frameBytes),
    )
  }

  get tsStats(): { packets: number; syncErrors: number } {
    return this.decoder.stats
  }

  reset(): void {
    this.decoder.reset()
  }

  /** Release the WASM decoder state; the instance must not be used afterwards. */
  dispose(): void {
    this.decoder.destroy()
  }

  /** Decode a batch of equalized data-carrier planes into MPEG-TS bytes. */
  decode(symbols: readonly ComplexPlane[]): Uint8Array {
    const dc = this.carriersPerSymbol
    const re = new Float32Array(symbols.length * dc)
    const im = new Float32Array(symbols.length * dc)
    for (let i = 0; i < symbols.length; i++) {
      const plane = symbols[i]
      if (plane.re.length !== dc) {
        throw new Error(`expected ${dc} carriers, got ${plane.re.length}`)
      }
      re.set(plane.re, i * dc)
      im.set(plane.im, i * dc)
    }
    return this.decoder.decode(re, im, symbols.length)
  }

  /**
   * Decode a batch already laid out contiguously as `symbolCount` planes of
   * `carriersPerSymbol` complex values each, avoiding the per-plane repacking.
   */
  decodeContiguous(re: Float32Array, im: Float32Array, symbolCount: number): Uint8Array {
    return this.decoder.decode(re, im, symbolCount)
  }
}
