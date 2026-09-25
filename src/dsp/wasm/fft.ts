/**
 * WebAssembly FFT backend (WASM implementation of `FftBackend`).
 *
 * Drop-in replacement for `TsFftBackend`; see `wasm/fft/src/lib.rs`.
 */

import type { FftBackend } from '../backend'
import { wasmFree, wasmAlloc, WasmHeap, instantiateWasm, type WasmModule } from './loadWasm'
import { wasmBase64 } from './fft.bytes'

const MAX_FFT = 8192

type Transform = (re: number, im: number, n: number) => void

export class WasmFftBackend implements FftBackend {
  readonly name = 'wasm-fft'
  private readonly wasm: WasmModule
  private readonly heap: WasmHeap
  private pRe = 0
  private pIm = 0
  private cap = 0

  constructor() {
    this.wasm = instantiateWasm(wasmBase64)
    this.heap = new WasmHeap(this.wasm.memory)
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
    this.heap.f32(this.pRe, length).set(srcRe.subarray(srcOffset, srcOffset + length))
    this.heap.f32(this.pIm, length).set(srcIm.subarray(srcOffset, srcOffset + length))
    ;(this.wasm.exports.fft_forward as Transform)(this.pRe, this.pIm, length)
    dstRe.set(this.heap.f32(this.pRe, length))
    dstIm.set(this.heap.f32(this.pIm, length))
  }

  private ensure(n: number): void {
    if (n <= this.cap) return
    if (this.cap > 0) {
      wasmFree(this.wasm, this.pRe, this.cap * 4)
      wasmFree(this.wasm, this.pIm, this.cap * 4)
    }
    this.pRe = wasmAlloc(this.wasm, n * 4)
    this.pIm = wasmAlloc(this.wasm, n * 4)
    this.cap = n
  }

  dispose(): void {
    if (this.cap === 0) return
    wasmFree(this.wasm, this.pRe, this.cap * 4)
    wasmFree(this.wasm, this.pIm, this.cap * 4)
    this.cap = 0
  }

  private run(re: Float32Array, im: Float32Array, fn: string, scaled: boolean): void {
    const n = re.length
    if (n <= 1) {
      if (scaled && n === 1) re[0] *= 1
      return
    }
    this.ensure(n)
    this.heap.f32(this.pRe, n).set(re)
    this.heap.f32(this.pIm, n).set(im)
    ;(this.wasm.exports[fn] as Transform)(this.pRe, this.pIm, n)
    re.set(this.heap.f32(this.pRe, n))
    im.set(this.heap.f32(this.pIm, n))
  }
}
