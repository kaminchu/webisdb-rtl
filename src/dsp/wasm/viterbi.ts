/**
 * WebAssembly Viterbi backend (WASM implementation of `ViterbiBackend`).
 *
 * Drop-in replacement for `TsViterbiBackend` / `StreamingViterbi`; see
 * `wasm/viterbi/src/lib.rs`.
 */

import type { ViterbiBackend, ViterbiRate } from '../backend'
import { wasmAlloc, wasmFree, WasmHeap, type WasmModule } from './loadWasm'
import { wasm, heap } from './dsp'

const RATE_INDEX: Record<ViterbiRate, number> = {
  '1/2': 0,
  '2/3': 1,
  '3/4': 2,
  '5/6': 3,
  '7/8': 4,
}

type DecodeFn = (
  inPtr: number,
  len: number,
  rate: number,
  terminate: number,
  outPtr: number,
) => number

type StreamCreateFn = (rate: number) => number
type StreamFeedFn = (ptr: number, soft: number) => number
type StreamBlockFn = (
  ptr: number,
  inPtr: number,
  len: number,
  outPtr: number,
  outCap: number,
) => number
type StreamVoidFn = (ptr: number) => void

export class WasmViterbiBackend implements ViterbiBackend {
  readonly name = 'wasm-viterbi'
  private readonly wasm: WasmModule
  private readonly heap: WasmHeap

  constructor() {
    this.wasm = wasm
    this.heap = heap
  }

  decode(input: Uint8Array, rate: ViterbiRate, terminate: boolean): Uint8Array {
    return this.run(input, rate, terminate, 'viterbi_decode', false)
  }

  decodeSoft(input: Int8Array, rate: ViterbiRate, terminate: boolean): Uint8Array {
    return this.run(input, rate, terminate, 'viterbi_decode_soft', true)
  }

  private run(
    input: Uint8Array | Int8Array,
    rate: ViterbiRate,
    terminate: boolean,
    fn: string,
    soft: boolean,
  ): Uint8Array {
    if (input.length === 0) return new Uint8Array(0)
    const pIn = wasmAlloc(this.wasm, input.length)
    const pOut = wasmAlloc(this.wasm, input.length)
    try {
      if (soft) this.heap.i8(pIn, input.length).set(input as Int8Array)
      else this.heap.u8(pIn, input.length).set(input as Uint8Array)
      const n = (this.wasm.exports[fn] as DecodeFn)(
        pIn,
        input.length,
        RATE_INDEX[rate],
        terminate ? 1 : 0,
        pOut,
      )
      const out = new Uint8Array(n)
      if (n > 0) out.set(this.heap.u8(pOut, n))
      return out
    } finally {
      wasmFree(this.wasm, pIn, input.length)
      wasmFree(this.wasm, pOut, input.length)
    }
  }
}

export class WasmStreamingViterbi {
  private readonly wasm: WasmModule
  private readonly heap: WasmHeap
  private readonly onByte: ((byte: number) => void) | null
  private readonly ptr: number
  private cap = 0
  private pIn = 0
  private pOut = 0

  constructor(rate: ViterbiRate, onByte?: (byte: number) => void) {
    this.wasm = wasm
    this.heap = heap
    this.onByte = onByte ?? null
    this.ptr = (this.wasm.exports.viterbi_stream_create as StreamCreateFn)(RATE_INDEX[rate])
  }

  reset(): void {
    ;(this.wasm.exports.viterbi_stream_reset as StreamVoidFn)(this.ptr)
  }

  feedSoft(soft: number): void {
    const byte = (this.wasm.exports.viterbi_stream_feed_soft as StreamFeedFn)(this.ptr, soft)
    if (byte >= 0 && this.onByte !== null) this.onByte(byte)
  }

  feedSoftBlock(soft: Int8Array): Uint8Array {
    if (soft.length === 0) return new Uint8Array(0)
    this.ensure(soft.length)
    this.heap.i8(this.pIn, soft.length).set(soft)
    const n = (this.wasm.exports.viterbi_stream_feed_soft_block as StreamBlockFn)(
      this.ptr,
      this.pIn,
      soft.length,
      this.pOut,
      soft.length,
    )
    const out = new Uint8Array(n)
    if (n > 0) out.set(this.heap.u8(this.pOut, n))
    if (this.onByte !== null) for (let i = 0; i < n; i++) this.onByte(out[i])
    return out
  }

  dispose(): void {
    if (this.cap > 0) {
      wasmFree(this.wasm, this.pIn, this.cap)
      wasmFree(this.wasm, this.pOut, this.cap)
      this.cap = 0
    }
    ;(this.wasm.exports.viterbi_stream_destroy as StreamVoidFn)(this.ptr)
  }

  private ensure(size: number): void {
    if (size <= this.cap) return
    if (this.cap > 0) {
      wasmFree(this.wasm, this.pIn, this.cap)
      wasmFree(this.wasm, this.pOut, this.cap)
    }
    this.pIn = wasmAlloc(this.wasm, size)
    this.pOut = wasmAlloc(this.wasm, size)
    this.cap = size
  }
}
