/**
 * Shared instance of the merged DSP WebAssembly module.
 *
 * Every kernel wrapper imports this so the whole receive chain runs inside one
 * `WebAssembly.Instance` with a single linear memory and allocator, instead of
 * one module/memory per stage.
 */

import { instantiateWasm, WasmHeap, type WasmModule } from './loadWasm'
import { wasmBase64 } from './dsp.bytes'

export const wasm: WasmModule = instantiateWasm(wasmBase64)
export const heap = new WasmHeap(wasm.memory)
