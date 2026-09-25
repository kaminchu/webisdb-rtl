/**
 * Shared instance of the merged DSP WebAssembly module.
 *
 * The non-threaded kernel (`dsp.bytes.ts`) is instantiated synchronously at
 * import time so unit tests and single-threaded environments work unchanged.
 * When the document is cross-origin isolated, `initDspThreads` swaps in the
 * threaded build (built by `npm run build:wasm` into `./pkg`) and starts a Rayon
 * thread pool; wrappers read the live `wasm`/`heap` bindings, so all DSP objects
 * must be created after the swap.
 */

import { instantiateWasm, WasmHeap, type WasmModule } from './loadWasm'
import { wasmBase64 } from './dsp.bytes'

export let wasm: WasmModule = instantiateWasm(wasmBase64)
export let heap = new WasmHeap(wasm.memory)

/** Threads reserved for DSP; leaves headroom for the UI/decoder on mobile. */
const MAX_DSP_THREADS = 4

let threadsEnabled = false

export function dspThreadsEnabled(): boolean {
  return threadsEnabled
}

/**
 * Replace the synchronous single-thread module with the Rayon-enabled one.
 * Returns `true` once the thread pool is running. Call before constructing any
 * DSP object; existing objects hold pointers into the old memory and are invalid
 * after a successful swap.
 */
export async function initDspThreads(): Promise<boolean> {
  if (threadsEnabled) return true
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated === true
  if (!isolated || typeof SharedArrayBuffer === 'undefined') return false
  try {
    const mod = await import('./pkg/dsp.js')
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true })
    const exportsObject = await mod.default({ memory })
    const hc =
      typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 2
    const threads = Math.max(1, Math.min(MAX_DSP_THREADS, hc - 1))
    await mod.initThreadPool(threads)
    wasm = {
      raw: exportsObject as unknown as WebAssembly.Instance,
      memory,
      exports: exportsObject as unknown as Record<string, unknown>,
    }
    heap = new WasmHeap(memory)
    threadsEnabled = true
    console.info(`[dsp] WebAssembly threads enabled (${threads})`)
    return true
  } catch (error) {
    console.warn('DSP threads unavailable; using the single-thread kernel', error)
    return false
  }
}
