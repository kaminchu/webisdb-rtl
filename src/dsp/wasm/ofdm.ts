/**
 * WebAssembly OFDM synchronization and frequency offset backend.
 *
 * Drop-in replacements for `OfdmSynchronizer` and `FrequencyOffsetEstimator`;
 * see `wasm/ofdm/src/lib.rs`.
 */

import type { OfdmSyncResult } from '../stages/ofdmSync'
import type { FrequencyOffsetEstimate } from '../stages/frequencyCorrection'
import { instantiateWasm, wasmAlloc, wasmFree, WasmHeap, type WasmModule } from './loadWasm'
import { wasmBase64 } from './ofdm.bytes'

const SYNC_FIELDS = 5
const ESTIMATE_FIELDS = 3

type CreateSyncFn = (
  fftSize: number,
  giRatio: number,
  sampleRateHz: number,
  tracking: number,
) => number

type ProcessSyncFn = (
  state: number,
  rePtr: number,
  imPtr: number,
  len: number,
  out: number,
) => number

type ResetSyncFn = (state: number) => void
type StartsPtrFn = (state: number) => number
type EstimateFn = (
  fftSize: number,
  giRatio: number,
  sampleRateHz: number,
  rePtr: number,
  imPtr: number,
  len: number,
  maxSearch: number,
  out: number,
) => void

class Scratch {
  pRe = 0
  pIm = 0
  cap = 0
  private readonly wasm: WasmModule

  constructor(wasm: WasmModule) {
    this.wasm = wasm
  }

  stage(re: Float32Array, im: Float32Array): void {
    const len = re.length
    if (len === 0) return
    if (len > this.cap) {
      if (this.cap > 0) {
        wasmFree(this.wasm, this.pRe, this.cap * 4)
        wasmFree(this.wasm, this.pIm, this.cap * 4)
      }
      this.pRe = wasmAlloc(this.wasm, len * 4)
      this.pIm = wasmAlloc(this.wasm, len * 4)
      this.cap = len
    }
    const heap = new WasmHeap(this.wasm.memory)
    heap.f32(this.pRe, len).set(re)
    heap.f32(this.pIm, len).set(im)
  }
}

/** Stateful OFDM synchronizer backed by the Rust kernel. */
export class WasmOfdmSynchronizer {
  private readonly wasm: WasmModule
  private readonly heap: WasmHeap
  private readonly scratch: Scratch
  private readonly state: number
  private readonly out: number

  constructor(fftSize: number, giRatio: number, sampleRateHz: number, tracking = false) {
    this.wasm = instantiateWasm(wasmBase64)
    this.heap = new WasmHeap(this.wasm.memory)
    this.scratch = new Scratch(this.wasm)
    this.state = (this.wasm.exports.ofdm_sync_create as CreateSyncFn)(
      fftSize,
      giRatio,
      sampleRateHz,
      tracking ? 1 : 0,
    )
    this.out = wasmAlloc(this.wasm, SYNC_FIELDS * 8)
  }

  reset(): void {
    ;(this.wasm.exports.ofdm_sync_reset as ResetSyncFn)(this.state)
  }

  dispose(): void {
    ;(this.wasm.exports.ofdm_sync_destroy as ResetSyncFn)(this.state)
    wasmFree(this.wasm, this.out, SYNC_FIELDS * 8)
  }

  process(re: Float32Array, im: Float32Array): OfdmSyncResult {
    const len = re.length
    this.scratch.stage(re, im)
    const count = (this.wasm.exports.ofdm_sync_process as ProcessSyncFn)(
      this.state,
      this.scratch.pRe,
      this.scratch.pIm,
      len,
      this.out,
    )
    const startsPtr = (this.wasm.exports.ofdm_sync_starts_ptr as StartsPtrFn)(this.state)
    const symbolStarts = count > 0 ? Array.from(this.heap.f64(startsPtr, count)) : []
    const fields = this.heap.f64(this.out, SYNC_FIELDS)
    return {
      symbolStarts,
      fractionalOffsetHz: fields[4] !== 0 ? fields[3] : null,
      metric: fields[0],
      gammaMagnitude: fields[1],
      phi: fields[2],
    }
  }
}

/** Stateless frequency offset estimator backed by the Rust kernel. */
export class WasmFrequencyOffsetEstimator {
  private readonly wasm: WasmModule
  private readonly heap: WasmHeap
  private readonly scratch: Scratch
  private readonly out: number
  private readonly fftSize: number
  private readonly giRatio: number
  private readonly sampleRateHz: number

  constructor(fftSize: number, giRatio: number, sampleRateHz: number) {
    this.fftSize = fftSize
    this.giRatio = giRatio
    this.sampleRateHz = sampleRateHz
    this.wasm = instantiateWasm(wasmBase64)
    this.heap = new WasmHeap(this.wasm.memory)
    this.scratch = new Scratch(this.wasm)
    this.out = wasmAlloc(this.wasm, ESTIMATE_FIELDS * 8)
  }

  estimate(
    re: Float32Array,
    im: Float32Array,
    maxSearch = Number.POSITIVE_INFINITY,
  ): FrequencyOffsetEstimate {
    const len = re.length
    this.scratch.stage(re, im)
    ;(this.wasm.exports.ofdm_freq_estimate as EstimateFn)(
      this.fftSize,
      this.giRatio,
      this.sampleRateHz,
      this.scratch.pRe,
      this.scratch.pIm,
      len,
      maxSearch,
      this.out,
    )
    const fields = this.heap.f64(this.out, ESTIMATE_FIELDS)
    return {
      timingIndex: fields[0],
      metric: fields[1],
      fractionalOffsetHz: fields[2],
    }
  }

  dispose(): void {
    wasmFree(this.wasm, this.out, ESTIMATE_FIELDS * 8)
  }
}
