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
import { wasmAlloc, wasmFree } from './loadWasm'
import { wasm, heap } from './dsp'

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
type FreqTimeProcessFn = (
  state: number,
  perm: number,
  size: number,
  inRe: number,
  inIm: number,
  outRe: number,
  outIm: number,
  n: number,
  rotation: number,
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
  const scratch = ensureFrequencyScratch(n)
  heap.f32(scratch.inRe, n).set(plane.re)
  heap.f32(scratch.inIm, n).set(plane.im)
  exportFn<FrequencyFn>(fn)(
    perm,
    size,
    scratch.inRe,
    scratch.inIm,
    scratch.outRe,
    scratch.outIm,
    n,
    rotation,
  )
  return {
    re: heap.f32(scratch.outRe, n).slice(),
    im: heap.f32(scratch.outIm, n).slice(),
  }
}

interface FrequencyScratch {
  cap: number
  inRe: number
  inIm: number
  outRe: number
  outIm: number
}

let frequencyScratch: FrequencyScratch | null = null

function ensureFrequencyScratch(n: number): FrequencyScratch {
  if (frequencyScratch !== null && frequencyScratch.cap >= n) return frequencyScratch
  if (frequencyScratch !== null) {
    const bytes = frequencyScratch.cap * 4
    for (const p of [
      frequencyScratch.inRe,
      frequencyScratch.inIm,
      frequencyScratch.outRe,
      frequencyScratch.outIm,
    ]) {
      wasmFree(wasm, p, bytes)
    }
  }
  frequencyScratch = {
    cap: n,
    inRe: wasmAlloc(wasm, n * 4),
    inIm: wasmAlloc(wasm, n * 4),
    outRe: wasmAlloc(wasm, n * 4),
    outIm: wasmAlloc(wasm, n * 4),
  }
  return frequencyScratch
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
  private cap = 0
  private pIn = 0
  private pOut = 0

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
    this.freeScratch()
    exportFn<(state: number) => void>('soft_bit_deinterleaver_destroy')(this.state)
    this.state = 0
  }

  process(input: Int8Array): Int8Array {
    const n = input.length
    this.ensure(n)
    heap.i8(this.pIn, n).set(input)
    exportFn<SoftProcessFn>('soft_bit_deinterleaver_process')(this.state, this.pIn, n, this.pOut)
    return heap.i8(this.pOut, n).slice()
  }

  private ensure(n: number): void {
    if (n <= this.cap) return
    this.freeScratch()
    this.pIn = wasmAlloc(wasm, n)
    this.pOut = wasmAlloc(wasm, n)
    this.cap = n
  }

  private freeScratch(): void {
    if (this.cap === 0) return
    wasmFree(wasm, this.pIn, this.cap)
    wasmFree(wasm, this.pOut, this.cap)
    this.cap = 0
  }
}

/** WASM convolutional (Ramsey) time deinterleaver. */
export class WasmTimeDeinterleaver {
  private state = 0
  private readonly carriers: number
  private readonly pInRe: number
  private readonly pInIm: number
  private readonly pOutRe: number
  private readonly pOutIm: number

  constructor(mode: TransmissionMode, I: number) {
    this.carriers = MODE_PARAMS[mode].dataCarriersPerSegment
    const bytes = this.carriers * 4
    this.state = exportFn<TimeCreateFn>('time_deinterleaver_create')(this.carriers, I)
    this.pInRe = wasmAlloc(wasm, bytes)
    this.pInIm = wasmAlloc(wasm, bytes)
    this.pOutRe = wasmAlloc(wasm, bytes)
    this.pOutIm = wasmAlloc(wasm, bytes)
  }

  reset(): void {
    exportFn<(state: number) => void>('time_deinterleaver_reset')(this.state)
  }

  destroy(): void {
    const bytes = this.carriers * 4
    for (const p of [this.pInRe, this.pInIm, this.pOutRe, this.pOutIm]) {
      wasmFree(wasm, p, bytes)
    }
    exportFn<(state: number) => void>('time_deinterleaver_destroy')(this.state)
    this.state = 0
  }

  process(re: Float32Array, im: Float32Array): ComplexPlane {
    const n = this.carriers
    heap.f32(this.pInRe, n).set(re.subarray(0, n))
    heap.f32(this.pInIm, n).set(im.subarray(0, n))
    exportFn<TimeProcessFn>('time_deinterleaver_process')(
      this.state,
      this.pInRe,
      this.pInIm,
      this.pOutRe,
      this.pOutIm,
      n,
    )
    return {
      re: heap.f32(this.pOutRe, n).slice(),
      im: heap.f32(this.pOutIm, n).slice(),
    }
  }

  /**
   * Frequency-deinterleave `plane` and time-deinterleave it in a single WASM
   * call, avoiding a host round-trip of the intermediate plane.
   */
  processFrequencyDeinterleaved(
    plane: ComplexPlane,
    mode: TransmissionMode,
    rotation = 0,
  ): ComplexPlane {
    const { ptr: perm, size } = ensurePermutation(mode)
    const n = this.carriers
    heap.f32(this.pInRe, n).set(plane.re.subarray(0, n))
    heap.f32(this.pInIm, n).set(plane.im.subarray(0, n))
    exportFn<FreqTimeProcessFn>('frequency_time_deinterleave')(
      this.state,
      perm,
      size,
      this.pInRe,
      this.pInIm,
      this.pOutRe,
      this.pOutIm,
      n,
      rotation,
    )
    return {
      re: heap.f32(this.pOutRe, n).slice(),
      im: heap.f32(this.pOutIm, n).slice(),
    }
  }
}

/** WASM 12-branch convolutional byte deinterleaver. */
export class WasmByteDeinterleaver {
  private state = 0
  private cap = 0
  private pIn = 0
  private pOut = 0

  constructor() {
    this.state = exportFn<() => number>('byte_deinterleaver_create')()
  }

  reset(): void {
    exportFn<(state: number) => void>('byte_deinterleaver_reset')(this.state)
  }

  destroy(): void {
    this.freeScratch()
    exportFn<(state: number) => void>('byte_deinterleaver_destroy')(this.state)
    this.state = 0
  }

  process(input: Uint8Array): Uint8Array {
    const n = input.length
    this.ensure(n)
    heap.u8(this.pIn, n).set(input)
    exportFn<ByteProcessFn>('byte_deinterleaver_process')(this.state, this.pIn, n, this.pOut)
    return heap.u8(this.pOut, n).slice()
  }

  processByte(value: number): number {
    return exportFn<ByteProcessByteFn>('byte_deinterleaver_process_byte')(this.state, value)
  }

  private ensure(n: number): void {
    if (n <= this.cap) return
    this.freeScratch()
    this.pIn = wasmAlloc(wasm, n)
    this.pOut = wasmAlloc(wasm, n)
    this.cap = n
  }

  private freeScratch(): void {
    if (this.cap === 0) return
    wasmFree(wasm, this.pIn, this.cap)
    wasmFree(wasm, this.pOut, this.cap)
    this.cap = 0
  }
}
