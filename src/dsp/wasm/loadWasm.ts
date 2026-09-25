/**
 * Synchronous WebAssembly loader for the DSP kernels.
 *
 * The kernels are Rust `wasm32-unknown-unknown` cdylibs embedded as base64 so
 * they can be instantiated synchronously without fetch/asset plumbing. DSP runs
 * in the receiver worker (and in Node under Vitest), both of which permit the
 * synchronous `WebAssembly.Module`/`Instance` constructors for modules > 4 KiB.
 */

export interface WasmModule {
  readonly raw: WebAssembly.Instance
  readonly memory: WebAssembly.Memory
  /** Typed access to exported functions. */
  readonly exports: Record<string, unknown>
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = (() => {
  const table = new Uint8Array(256)
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i
  return table
})()

function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  const out = new Uint8Array(((clean.length * 3) >> 2) - padding)
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const a = LOOKUP[clean.charCodeAt(i)]
    const b = LOOKUP[clean.charCodeAt(i + 1)]
    const c = LOOKUP[clean.charCodeAt(i + 2)]
    const d = LOOKUP[clean.charCodeAt(i + 3)]
    out[o++] = (a << 2) | (b >> 4)
    if (o < out.length) out[o++] = ((b & 15) << 4) | (c >> 2)
    if (o < out.length) out[o++] = ((c & 3) << 6) | d
  }
  return out
}

const cache = new Map<string, WasmModule>()

/**
 * Instantiate the module embedded in `base64`. Results are cached per module
 * binary so repeated loads share one instance/memory.
 */
export function instantiateWasm(base64: string): WasmModule {
  const cached = cache.get(base64)
  if (cached) return cached
  const module = new WebAssembly.Module(decodeBase64(base64))
  const raw = new WebAssembly.Instance(module, {})
  const exports = raw.exports as Record<string, unknown>
  const memory = exports.memory as WebAssembly.Memory
  const wasm: WasmModule = { raw, memory, exports }
  cache.set(base64, wasm)
  return wasm
}

/** Convenience typed views onto a module's linear memory. */
export class WasmHeap {
  private readonly memory: WebAssembly.Memory

  constructor(memory: WebAssembly.Memory) {
    this.memory = memory
  }

  get byteLength(): number {
    return this.memory.buffer.byteLength
  }

  f32(ptr: number, len: number): Float32Array {
    return new Float32Array(this.memory.buffer, ptr, len)
  }

  u8(ptr: number, len: number): Uint8Array {
    return new Uint8Array(this.memory.buffer, ptr, len)
  }

  i8(ptr: number, len: number): Int8Array {
    return new Int8Array(this.memory.buffer, ptr, len)
  }

  i32(ptr: number, len: number): Int32Array {
    return new Int32Array(this.memory.buffer, ptr, len)
  }

  f64(ptr: number, len: number): Float64Array {
    return new Float64Array(this.memory.buffer, ptr, len)
  }
}

/** Allocate `bytes` (8-byte aligned) inside a module's linear memory. */
export function wasmAlloc(wasm: WasmModule, bytes: number): number {
  const alloc = wasm.exports.dsp_alloc as (size: number) => number
  return alloc(bytes)
}

/** Release memory previously returned by `wasmAlloc`. */
export function wasmFree(wasm: WasmModule, ptr: number, bytes: number): void {
  const free = wasm.exports.dsp_free as (ptr: number, size: number) => void
  free(ptr, bytes)
}
