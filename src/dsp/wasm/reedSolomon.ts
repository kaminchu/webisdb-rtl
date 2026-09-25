/**
 * WebAssembly Reed-Solomon backend (WASM implementation of `RsBackend`).
 *
 * Drop-in replacement for `TsRsBackend`; see `wasm/reed_solomon/src/lib.rs`.
 */

import type { RsBackend } from '../backend'
import { wasmAlloc, WasmHeap, type WasmModule } from './loadWasm'
import { wasm, heap } from './dsp'

const RS_BLOCK_SIZE = 204
const RS_DATA_SIZE = 188

type RsDecode = (inPtr: number, outPtr: number) => number

export class WasmRsBackend implements RsBackend {
  readonly name = 'wasm-rs'
  private readonly wasm: WasmModule
  private readonly heap: WasmHeap
  private readonly pIn: number
  private readonly pOut: number

  constructor() {
    this.wasm = wasm
    this.heap = heap
    this.pIn = wasmAlloc(this.wasm, RS_BLOCK_SIZE)
    this.pOut = wasmAlloc(this.wasm, RS_DATA_SIZE)
  }

  decode(block: Uint8Array): Uint8Array | null {
    if (block.length !== RS_BLOCK_SIZE) return null
    this.heap.u8(this.pIn, RS_BLOCK_SIZE).set(block)
    const ok = (this.wasm.exports.rs_decode as RsDecode)(this.pIn, this.pOut)
    if (ok !== 1) return null
    return this.heap.u8(this.pOut, RS_DATA_SIZE).slice()
  }
}
