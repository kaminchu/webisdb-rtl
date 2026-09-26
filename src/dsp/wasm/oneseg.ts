/**
 * WebAssembly fused one-seg FEC decoder.
 *
 * Wraps the `oneseg` kernel in `wasm/dsp/src/oneseg.rs`: one call decodes a
 * batch of equalized data-carrier planes through time deinterleave, soft
 * demapping, bit deinterleave, Viterbi, byte deinterleave, energy descramble,
 * Reed-Solomon and TS assembly entirely inside linear memory.
 */

import type { CarrierModulation, TransmissionMode } from '../isdbtParams'
import { MODE_PARAMS } from '../isdbtParams'
import type { ViterbiRate } from '../backend'
import { bitDeinterleaveDelays, frequencyPermutation } from '../stages/deinterleave'
import { wasmAlloc, wasmFree } from './loadWasm'
import { wasm, heap } from './dsp'

const RATE_INDEX: Record<ViterbiRate, number> = {
  '1/2': 0,
  '2/3': 1,
  '3/4': 2,
  '5/6': 3,
  '7/8': 4,
}

type CreateFn = (
  modulation: number,
  rate: number,
  interleaveUnit: number,
  carriers: number,
  frameBytes: number,
  permPtr: number,
  permSize: number,
  delaysPtr: number,
  delayCount: number,
) => number

type DecodeFn = (state: number, rePtr: number, imPtr: number, symbolCount: number) => number
type PtrFn = (state: number) => void
type TsPtrFn = (state: number) => number
type U32Fn = (state: number) => number

export class WasmOneSegDecoder {
  private readonly state: number
  private readonly carriers: number
  private pRe = 0
  private pIm = 0
  private cap = 0

  constructor(
    mode: TransmissionMode,
    modulation: CarrierModulation,
    rate: ViterbiRate,
    interleaveUnit: number,
    frameBytes: number,
  ) {
    this.carriers = MODE_PARAMS[mode].dataCarriersPerSegment
    const perm = frequencyPermutation(mode)
    const delays = bitDeinterleaveDelays(modulation)
    const permPtr = wasmAlloc(wasm, perm.length * 4)
    const delaysPtr = wasmAlloc(wasm, delays.length * 4)
    try {
      new Uint32Array(wasm.memory.buffer, permPtr, perm.length).set(perm)
      new Uint32Array(wasm.memory.buffer, delaysPtr, delays.length).set(delays)
      this.state = (wasm.exports.oneseg_decoder_create as CreateFn)(
        modulation,
        RATE_INDEX[rate],
        interleaveUnit,
        this.carriers,
        frameBytes,
        permPtr,
        perm.length,
        delaysPtr,
        delays.length,
      )
    } finally {
      wasmFree(wasm, permPtr, perm.length * 4)
      wasmFree(wasm, delaysPtr, delays.length * 4)
    }
  }

  reset(): void {
    ;(wasm.exports.oneseg_decoder_reset as PtrFn)(this.state)
  }

  destroy(): void {
    this.freeScratch()
    ;(wasm.exports.oneseg_decoder_destroy as PtrFn)(this.state)
  }

  get stats(): { packets: number; syncErrors: number } {
    return {
      packets: (wasm.exports.oneseg_decoder_packets as U32Fn)(this.state),
      syncErrors: (wasm.exports.oneseg_decoder_sync_errors as U32Fn)(this.state),
    }
  }

  /**
   * Ensure the input staging buffer can hold `symbolCount` planes. Call this
   * before taking a view of a shared buffer that must stay valid across the
   * subsequent decode, since the allocation may grow linear memory.
   */
  ensureInput(symbolCount: number): void {
    this.ensure(symbolCount * this.carriers)
  }

  /** Decode `symbolCount` contiguous data-carrier planes (stride = carriers). */
  decode(re: Float32Array, im: Float32Array, symbolCount: number): Uint8Array {
    if (symbolCount === 0) return new Uint8Array(0)
    const n = symbolCount * this.carriers
    this.ensure(n)
    heap.f32(this.pRe, n).set(re.subarray(0, n))
    heap.f32(this.pIm, n).set(im.subarray(0, n))
    return this.decodePointers(this.pRe, this.pIm, symbolCount)
  }

  /**
   * Decode planes that already live in this WASM instance (for example the
   * front end's pending buffer), skipping the staging copy.
   */
  decodePointers(rePtr: number, imPtr: number, symbolCount: number): Uint8Array {
    if (symbolCount === 0) return new Uint8Array(0)
    if (rePtr === 0 || imPtr === 0) throw new Error('decodePointers requires input pointers')
    const len = (wasm.exports.oneseg_decoder_decode_batch as DecodeFn)(
      this.state,
      rePtr,
      imPtr,
      symbolCount,
    )
    if (len === 0) return new Uint8Array(0)
    const ptr = (wasm.exports.oneseg_decoder_ts_ptr as TsPtrFn)(this.state)
    return heap.u8(ptr, len).slice()
  }

  private ensure(n: number): void {
    if (n <= this.cap) return
    this.freeScratch()
    this.pRe = wasmAlloc(wasm, n * 4)
    this.pIm = wasmAlloc(wasm, n * 4)
    this.cap = n
  }

  private freeScratch(): void {
    if (this.cap === 0) return
    wasmFree(wasm, this.pRe, this.cap * 4)
    wasmFree(wasm, this.pIm, this.cap * 4)
    this.pRe = 0
    this.pIm = 0
    this.cap = 0
  }
}
