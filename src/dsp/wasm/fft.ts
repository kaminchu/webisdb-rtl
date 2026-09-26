/**
 * WebAssembly FFT backend (WASM implementation of `FftBackend`).
 *
 * Uses the reusable `FftPlan` in `wasm/dsp/src/fft.rs`: bit reversal and
 * per-stage twiddles are cached per transform size, so no per-call `sin`/`cos`
 * work and f32x4 SIMD on the locked hot path.
 */

import type { FftBackend } from '../backend'
import { wasmFree, wasmAlloc } from './loadWasm'
import { wasm, heap } from './dsp'

const MAX_FFT = 8192

type Transform = (re: number, im: number, n: number) => void
type PlanCreate = (n: number) => number
type PlanTransform = (ptr: number, re: number, im: number) => void
type PlanDestroy = (ptr: number) => void

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

export class WasmFftBackend implements FftBackend {
  readonly name = 'wasm-fft'
  private pRe = 0
  private pIm = 0
  private cap = 0
  private readonly plans = new Map<number, number>()

  constructor() {
    this.ensure(MAX_FFT)
  }

  forward(re: Float32Array, im: Float32Array): void {
    this.run(re, im, false)
  }

  inverse(re: Float32Array, im: Float32Array): void {
    this.run(re, im, true)
  }

  /**
   * Forward-transform `length` samples starting at `srcOffset` and write the
   * result to `dstRe`/`dstIm`, so callers can transform a slice of a larger
   * buffer without staging it into a temporary array first.
   */
  forwardFrom(
    srcRe: Float32Array,
    srcIm: Float32Array,
    srcOffset: number,
    length: number,
    dstRe: Float32Array,
    dstIm: Float32Array,
  ): void {
    if (length <= 1) {
      if (length === 1) {
        dstRe[0] = srcRe[srcOffset]
        dstIm[0] = srcIm[srcOffset]
      }
      return
    }
    this.ensure(length)
    heap.f32(this.pRe, length).set(srcRe.subarray(srcOffset, srcOffset + length))
    heap.f32(this.pIm, length).set(srcIm.subarray(srcOffset, srcOffset + length))
    this.transform(this.pRe, this.pIm, length, false)
    dstRe.set(heap.f32(this.pRe, length))
    dstIm.set(heap.f32(this.pIm, length))
  }

  private plan(n: number): number {
    let ptr = this.plans.get(n)
    if (ptr !== undefined) return ptr
    ptr = (wasm.exports.fft_plan_create as PlanCreate)(n)
    this.plans.set(n, ptr)
    return ptr
  }

  private transform(pRe: number, pIm: number, n: number, inverse: boolean): void {
    const ptr = this.plan(n)
    if (ptr === 0) {
      ;(wasm.exports[inverse ? 'fft_inverse' : 'fft_forward'] as Transform)(pRe, pIm, n)
      return
    }
    ;(wasm.exports[inverse ? 'fft_plan_inverse' : 'fft_plan_forward'] as PlanTransform)(
      ptr,
      pRe,
      pIm,
    )
  }

  private ensure(n: number): void {
    if (n <= this.cap) return
    if (this.cap > 0) {
      wasmFree(wasm, this.pRe, this.cap * 4)
      wasmFree(wasm, this.pIm, this.cap * 4)
    }
    this.pRe = wasmAlloc(wasm, n * 4)
    this.pIm = wasmAlloc(wasm, n * 4)
    this.cap = n
  }

  dispose(): void {
    for (const ptr of this.plans.values()) {
      ;(wasm.exports.fft_plan_destroy as PlanDestroy)(ptr)
    }
    this.plans.clear()
    if (this.cap === 0) return
    wasmFree(wasm, this.pRe, this.cap * 4)
    wasmFree(wasm, this.pIm, this.cap * 4)
    this.cap = 0
  }

  private run(re: Float32Array, im: Float32Array, inverse: boolean): void {
    const n = re.length
    if (n <= 1) return
    this.ensure(n)
    heap.f32(this.pRe, n).set(re)
    heap.f32(this.pIm, n).set(im)
    if (isPowerOfTwo(n)) {
      this.transform(this.pRe, this.pIm, n, inverse)
    } else {
      ;(wasm.exports[inverse ? 'fft_inverse' : 'fft_forward'] as Transform)(this.pRe, this.pIm, n)
    }
    re.set(heap.f32(this.pRe, n))
    im.set(heap.f32(this.pIm, n))
  }
}
