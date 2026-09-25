/**
 * WebAssembly FFT backend (WASM implementation of `FftBackend`).
 *
 * Drop-in replacement for `TsFftBackend`; see `wasm/dsp/src/fft.rs`.
 */

import type { FftBackend } from '../backend'
import { wasmFree, wasmAlloc } from './loadWasm'
import { wasm, heap } from './dsp'

const MAX_FFT = 8192

type Transform = (re: number, im: number, n: number) => void
type BatchFn = (
  re: number,
  im: number,
  total: number,
  starts: number,
  count: number,
  n: number,
  outRe: number,
  outIm: number,
) => void

export class WasmFftBackend implements FftBackend {
  readonly name = 'wasm-fft'
  private pRe = 0
  private pIm = 0
  private cap = 0
  private pBatchRe = 0
  private pBatchIm = 0
  private batchCap = 0
  private pOutRe = 0
  private pOutIm = 0
  private outCap = 0
  private pStarts = 0
  private startsCap = 0

  constructor() {
    this.ensure(MAX_FFT)
  }

  forward(re: Float32Array, im: Float32Array): void {
    this.run(re, im, 'fft_forward', false)
  }

  inverse(re: Float32Array, im: Float32Array): void {
    this.run(re, im, 'fft_inverse', true)
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
    ;(wasm.exports.fft_forward as Transform)(this.pRe, this.pIm, length)
    dstRe.set(heap.f32(this.pRe, length))
    dstIm.set(heap.f32(this.pIm, length))
  }

  /**
   * Forward-transform many length-`n` windows starting at `starts` inside
   * `srcRe`/`srcIm` into `dstRe`/`dstIm` (stride `n`). When the threaded kernel
   * is loaded the whole batch runs on the Rayon pool; otherwise it is a plain
   * loop. `dstRe`/`dstIm` must hold at least `starts.length * n` values.
   */
  forwardBatchFrom(
    srcRe: Float32Array,
    srcIm: Float32Array,
    starts: Int32Array,
    n: number,
    dstRe: Float32Array,
    dstIm: Float32Array,
  ): void {
    const count = starts.length
    if (count === 0 || n <= 1) return
    const total = srcRe.length
    this.ensureBatch(total, count * n, count)
    heap.f32(this.pBatchRe, total).set(srcRe)
    heap.f32(this.pBatchIm, total).set(srcIm)
    heap.i32(this.pStarts, count).set(starts)
    ;(wasm.exports.fft_batch as BatchFn)(
      this.pBatchRe,
      this.pBatchIm,
      total,
      this.pStarts,
      count,
      n,
      this.pOutRe,
      this.pOutIm,
    )
    const bins = count * n
    dstRe.set(heap.f32(this.pOutRe, bins))
    dstIm.set(heap.f32(this.pOutIm, bins))
  }

  private ensureBatch(total: number, bins: number, count: number): void {
    if (total > this.batchCap) {
      if (this.batchCap > 0) {
        wasmFree(wasm, this.pBatchRe, this.batchCap * 4)
        wasmFree(wasm, this.pBatchIm, this.batchCap * 4)
      }
      this.pBatchRe = wasmAlloc(wasm, total * 4)
      this.pBatchIm = wasmAlloc(wasm, total * 4)
      this.batchCap = total
    }
    if (bins > this.outCap) {
      if (this.outCap > 0) {
        wasmFree(wasm, this.pOutRe, this.outCap * 4)
        wasmFree(wasm, this.pOutIm, this.outCap * 4)
      }
      this.pOutRe = wasmAlloc(wasm, bins * 4)
      this.pOutIm = wasmAlloc(wasm, bins * 4)
      this.outCap = bins
    }
    if (count > this.startsCap) {
      if (this.startsCap > 0) wasmFree(wasm, this.pStarts, this.startsCap * 4)
      this.pStarts = wasmAlloc(wasm, count * 4)
      this.startsCap = count
    }
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
    if (this.cap > 0) {
      wasmFree(wasm, this.pRe, this.cap * 4)
      wasmFree(wasm, this.pIm, this.cap * 4)
      this.cap = 0
    }
    if (this.batchCap > 0) {
      wasmFree(wasm, this.pBatchRe, this.batchCap * 4)
      wasmFree(wasm, this.pBatchIm, this.batchCap * 4)
      this.batchCap = 0
    }
    if (this.outCap > 0) {
      wasmFree(wasm, this.pOutRe, this.outCap * 4)
      wasmFree(wasm, this.pOutIm, this.outCap * 4)
      this.outCap = 0
    }
    if (this.startsCap > 0) {
      wasmFree(wasm, this.pStarts, this.startsCap * 4)
      this.startsCap = 0
    }
  }

  private run(re: Float32Array, im: Float32Array, fn: string, scaled: boolean): void {
    const n = re.length
    if (n <= 1) {
      if (scaled && n === 1) re[0] *= 1
      return
    }
    this.ensure(n)
    heap.f32(this.pRe, n).set(re)
    heap.f32(this.pIm, n).set(im)
    ;(wasm.exports[fn] as Transform)(this.pRe, this.pIm, n)
    re.set(heap.f32(this.pRe, n))
    im.set(heap.f32(this.pIm, n))
  }
}
