/**
 * WebAssembly deinterleaving backends.
 *
 * Drop-in replacements for the TypeScript classes/functions in
 * `../stages/deinterleave`; see `wasm/deinterleave/src/lib.rs` for the kernels.
 */

import type { CarrierModulation, TransmissionMode } from '../isdbtParams'
import { MODE_PARAMS } from '../isdbtParams'
import type { ComplexPlane } from '../stages/carrierDemod'
import { bitDeinterleaveDelays, frequencyPermutation } from '../stages/deinterleave'
import { instantiateWasm, wasmAlloc, wasmFree, WasmHeap, type WasmModule } from './loadWasm'
import { wasmBase64 } from './deinterleave.bytes'

const wasm: WasmModule = instantiateWasm(wasmBase64)
const heap = new WasmHeap(wasm.memory)

type FrequencyFn = (
  perm: number,
  size: number,
  inRe: number,
  inIm: number,
  outRe: number,
  outIm: number,
  n: number,
  rotation: number,
) => void

type SoftCreateFn = (delays: number, count: number) => number
type SoftProcessFn = (state: number, input: number, len: number, out: number) => void
type TimeCreateFn = (carriers: number, interleaveUnit: number) => number
type TimeProcessFn = (
  state: number,
  inRe: number,
  inIm: number,
  outRe: number,
  outIm: number,
  n: number,
) => void
type ByteProcessByteFn = (state: number, value: number) => number
type ByteProcessFn = (state: number, input: number, len: number, out: number) => void

function exportFn<T>(name: string): T {
  return wasm.exports[name] as T
}

const permCache = new Map<TransmissionMode, { ptr: number; size: number }>()

function ensurePermutation(mode: TransmissionMode): { ptr: number; size: number } {
  const cached = permCache.get(mode)
  if (cached) return cached
  const perm = frequencyPermutation(mode)
  const ptr = wasmAlloc(wasm, perm.length * 4)
  new Uint32Array(wasm.memory.buffer, ptr, perm.length).set(perm)
  const entry = { ptr, size: perm.length }
  permCache.set(mode, entry)
  return entry
}

function frequencyRun(
  fn: string,
  plane: ComplexPlane,
  mode: TransmissionMode,
  rotation: number,
): ComplexPlane {
  const { ptr: perm, size } = ensurePermutation(mode)
  const n = plane.re.length
  const bytes = n * 4
  const inRe = wasmAlloc(wasm, bytes)
  const inIm = wasmAlloc(wasm, bytes)
  const outRe = wasmAlloc(wasm, bytes)
  const outIm = wasmAlloc(wasm, bytes)
  heap.f32(inRe, n).set(plane.re)
  heap.f32(inIm, n).set(plane.im)
  exportFn<FrequencyFn>(fn)(perm, size, inRe, inIm, outRe, outIm, n, rotation)
  const re = heap.f32(outRe, n).slice()
  const im = heap.f32(outIm, n).slice()
  wasmFree(wasm, inRe, bytes)
  wasmFree(wasm, inIm, bytes)
  wasmFree(wasm, outRe, bytes)
  wasmFree(wasm, outIm, bytes)
  return { re, im }
}

/** WASM `frequencyDeinterleave`: undo intra-segment frequency interleaving. */
export function frequencyDeinterleaveWasm(
  plane: ComplexPlane,
  mode: TransmissionMode,
  rotation = 0,
): ComplexPlane {
  return frequencyRun('frequency_deinterleave', plane, mode, rotation)
}

/** WASM `frequencyInterleave`: inverse of `frequencyDeinterleaveWasm`. */
export function frequencyInterleaveWasm(
  plane: ComplexPlane,
  mode: TransmissionMode,
  rotation = 0,
): ComplexPlane {
  return frequencyRun('frequency_interleave', plane, mode, rotation)
}

/** WASM soft per-carrier bit deinterleaver. */
export class WasmSoftBitDeinterleaver {
  private state = 0

  constructor(modulation: CarrierModulation) {
    const delays = bitDeinterleaveDelays(modulation)
    const bytes = delays.length * 4
    const ptr = wasmAlloc(wasm, bytes)
    new Uint32Array(wasm.memory.buffer, ptr, delays.length).set(delays)
    this.state = exportFn<SoftCreateFn>('soft_bit_deinterleaver_create')(ptr, delays.length)
    wasmFree(wasm, ptr, bytes)
  }

  reset(): void {
    exportFn<(state: number) => void>('soft_bit_deinterleaver_reset')(this.state)
  }

  destroy(): void {
    exportFn<(state: number) => void>('soft_bit_deinterleaver_destroy')(this.state)
    this.state = 0
  }

  process(input: Int8Array): Int8Array {
    const n = input.length
    const pIn = wasmAlloc(wasm, n)
    const pOut = wasmAlloc(wasm, n)
    heap.i8(pIn, n).set(input)
    exportFn<SoftProcessFn>('soft_bit_deinterleaver_process')(this.state, pIn, n, pOut)
    const out = heap.i8(pOut, n).slice()
    wasmFree(wasm, pIn, n)
    wasmFree(wasm, pOut, n)
    return out
  }
}

/** WASM convolutional (Ramsey) time deinterleaver. */
export class WasmTimeDeinterleaver {
  private state = 0
  private readonly carriers: number

  constructor(mode: TransmissionMode, I: number) {
    this.carriers = MODE_PARAMS[mode].dataCarriersPerSegment
    this.state = exportFn<TimeCreateFn>('time_deinterleaver_create')(this.carriers, I)
  }

  reset(): void {
    exportFn<(state: number) => void>('time_deinterleaver_reset')(this.state)
  }

  destroy(): void {
    exportFn<(state: number) => void>('time_deinterleaver_destroy')(this.state)
    this.state = 0
  }

  process(re: Float32Array, im: Float32Array): ComplexPlane {
    const n = this.carriers
    const bytes = n * 4
    const pInRe = wasmAlloc(wasm, bytes)
    const pInIm = wasmAlloc(wasm, bytes)
    const pOutRe = wasmAlloc(wasm, bytes)
    const pOutIm = wasmAlloc(wasm, bytes)
    heap.f32(pInRe, n).set(re.subarray(0, n))
    heap.f32(pInIm, n).set(im.subarray(0, n))
    exportFn<TimeProcessFn>('time_deinterleaver_process')(
      this.state,
      pInRe,
      pInIm,
      pOutRe,
      pOutIm,
      n,
    )
    const outRe = heap.f32(pOutRe, n).slice()
    const outIm = heap.f32(pOutIm, n).slice()
    wasmFree(wasm, pInRe, bytes)
    wasmFree(wasm, pInIm, bytes)
    wasmFree(wasm, pOutRe, bytes)
    wasmFree(wasm, pOutIm, bytes)
    return { re: outRe, im: outIm }
  }
}

/** WASM 12-branch convolutional byte deinterleaver. */
export class WasmByteDeinterleaver {
  private state = 0

  constructor() {
    this.state = exportFn<() => number>('byte_deinterleaver_create')()
  }

  reset(): void {
    exportFn<(state: number) => void>('byte_deinterleaver_reset')(this.state)
  }

  destroy(): void {
    exportFn<(state: number) => void>('byte_deinterleaver_destroy')(this.state)
    this.state = 0
  }

  process(input: Uint8Array): Uint8Array {
    const n = input.length
    const pIn = wasmAlloc(wasm, n)
    const pOut = wasmAlloc(wasm, n)
    heap.u8(pIn, n).set(input)
    exportFn<ByteProcessFn>('byte_deinterleaver_process')(this.state, pIn, n, pOut)
    const out = heap.u8(pOut, n).slice()
    wasmFree(wasm, pIn, n)
    wasmFree(wasm, pOut, n)
    return out
  }

  processByte(value: number): number {
    return exportFn<ByteProcessByteFn>('byte_deinterleaver_process_byte')(this.state, value)
  }
}
