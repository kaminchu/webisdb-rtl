/**
 * WebAssembly DSP kernels for DC removal, fractional resampling and NCO
 * correction.
 *
 * Drop-in replacements for `DcRemoval`, `FractionalResampler` and
 * `NcoCorrector`; see `wasm/dsp/src/resample.rs`.
 */

import { wasmFree, wasmAlloc } from './loadWasm'
import { wasm, heap } from './dsp'

type CreateFn = (a: number) => number
type NcoCreateFn = (offset: number, rate: number) => number
type ResampleCreateFn = (src: number, dst: number, cutoff: number) => number
type ProcessFn = (ptr: number, re: number, im: number, n: number) => void
type ResampleProcessFn = (ptr: number, re: number, im: number, n: number) => number
type PtrFn = (ptr: number) => void
type OutPtrFn = (ptr: number) => number
type SetOffsetFn = (ptr: number, offset: number) => void

/** Shared per-instance scratch buffers for staging input in wasm memory. */
class Scratch {
  private pRe = 0
  private pIm = 0
  private cap = 0

  ensure(n: number): void {
    if (n <= this.cap) return
    if (this.cap > 0) {
      wasmFree(wasm, this.pRe, this.cap * 4)
      wasmFree(wasm, this.pIm, this.cap * 4)
    }
    this.pRe = wasmAlloc(wasm, n * 4)
    this.pIm = wasmAlloc(wasm, n * 4)
    this.cap = n
  }

  write(re: Float32Array, im: Float32Array): void {
    this.ensure(re.length)
    heap.f32(this.pRe, re.length).set(re)
    heap.f32(this.pIm, im.length).set(im)
  }

  get rePtr(): number {
    return this.pRe
  }

  get imPtr(): number {
    return this.pIm
  }

  readBack(re: Float32Array, im: Float32Array): void {
    re.set(heap.f32(this.pRe, re.length))
    im.set(heap.f32(this.pIm, im.length))
  }

  free(): void {
    if (this.cap === 0) return
    wasmFree(wasm, this.pRe, this.cap * 4)
    wasmFree(wasm, this.pIm, this.cap * 4)
    this.pRe = 0
    this.pIm = 0
    this.cap = 0
  }
}

export class WasmDcRemoval {
  private readonly scratch = new Scratch()
  private readonly ptr: number
  private readonly processFn: ProcessFn
  private readonly resetFn: PtrFn

  constructor(alpha = 0.001) {
    this.processFn = wasm.exports.dc_process as ProcessFn
    this.resetFn = wasm.exports.dc_reset as PtrFn
    this.ptr = (wasm.exports.dc_create as CreateFn)(alpha)
  }

  process(re: Float32Array, im: Float32Array): void {
    if (re.length === 0) return
    this.scratch.write(re, im)
    this.processFn(this.ptr, this.scratch.rePtr, this.scratch.imPtr, re.length)
    this.scratch.readBack(re, im)
  }

  reset(): void {
    this.resetFn(this.ptr)
  }

  dispose(): void {
    this.scratch.free()
    ;(wasm.exports.dc_destroy as PtrFn)(this.ptr)
  }
}

export class WasmFractionalResampler {
  private readonly scratch = new Scratch()
  private readonly ptr: number
  private readonly processFn: ResampleProcessFn
  private readonly resetFn: PtrFn
  private readonly outReFn: OutPtrFn
  private readonly outImFn: OutPtrFn

  constructor(srcRate: number, dstRate: number, cutoffHz = 450_000) {
    if (srcRate <= 0 || dstRate <= 0) throw new Error('sample rates must be positive')
    this.processFn = wasm.exports.resample_process as ResampleProcessFn
    this.resetFn = wasm.exports.resample_reset as PtrFn
    this.outReFn = wasm.exports.resample_out_re as OutPtrFn
    this.outImFn = wasm.exports.resample_out_im as OutPtrFn
    this.ptr = (wasm.exports.resample_create as ResampleCreateFn)(srcRate, dstRate, cutoffHz)
  }

  reset(): void {
    this.resetFn(this.ptr)
  }

  process(re: Float32Array, im: Float32Array): { re: Float32Array; im: Float32Array } {
    if (re.length > 0) this.scratch.write(re, im)
    const n = this.processFn(this.ptr, this.scratch.rePtr, this.scratch.imPtr, re.length)
    if (n === 0) return { re: new Float32Array(0), im: new Float32Array(0) }
    const reOut = heap.f32(this.outReFn(this.ptr), n).slice()
    const imOut = heap.f32(this.outImFn(this.ptr), n).slice()
    return { re: reOut, im: imOut }
  }

  dispose(): void {
    this.scratch.free()
    ;(wasm.exports.resample_destroy as PtrFn)(this.ptr)
  }
}

export class WasmNcoCorrector {
  private readonly scratch = new Scratch()
  private readonly ptr: number
  private readonly processFn: ProcessFn
  private readonly resetFn: PtrFn
  private readonly setOffsetFn: SetOffsetFn

  constructor(offsetHz: number, sampleRateHz: number) {
    this.processFn = wasm.exports.nco_process as ProcessFn
    this.resetFn = wasm.exports.nco_reset as PtrFn
    this.setOffsetFn = wasm.exports.nco_set_offset as SetOffsetFn
    this.ptr = (wasm.exports.nco_create as NcoCreateFn)(offsetHz, sampleRateHz)
  }

  setOffset(offsetHz: number): void {
    this.setOffsetFn(this.ptr, offsetHz)
  }

  reset(): void {
    this.resetFn(this.ptr)
  }

  process(re: Float32Array, im: Float32Array): void {
    if (re.length === 0) return
    this.scratch.write(re, im)
    this.processFn(this.ptr, this.scratch.rePtr, this.scratch.imPtr, re.length)
    this.scratch.readBack(re, im)
  }

  dispose(): void {
    this.scratch.free()
    ;(wasm.exports.nco_destroy as PtrFn)(this.ptr)
  }
}
