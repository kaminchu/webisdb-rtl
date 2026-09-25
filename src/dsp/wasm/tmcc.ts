/**
 * WebAssembly TMCC decoder backend.
 *
 * Drop-in replacement for `TmccDecoder` in `../stages/tmcc`; see
 * `wasm/dsp/src/tmcc.rs`.
 */

import type { TransmissionMode } from '../isdbtParams'
import { MODE_PARAMS } from '../isdbtParams'
import type { TmccInfo, TmccLayerInfo } from '../../models/tmcc'
import { wasmAlloc, wasmFree } from './loadWasm'
import { wasm, heap } from './dsp'

const INFO_FIELDS = 21
const FRAME_BITS = 204

type CreateFn = (mode: number, giRatio: number) => number
type PushFn = (state: number, rePtr: number, imPtr: number) => number
type WriteInfoFn = (state: number, out: number) => void
type WriteBitsFn = (state: number, out: number) => void
type FrameStartFn = (state: number) => number
type StateFn = (state: number) => void

function readLayer(fields: Uint32Array, base: number): TmccLayerInfo | null {
  if (fields[base] === 0) return null
  return {
    modulation: fields[base + 1],
    codeRate: fields[base + 2],
    timeInterleave: fields[base + 3],
    segments: fields[base + 4],
  }
}

export class WasmTmccDecoder {
  private readonly state: number
  private readonly carriers: number
  private readonly pRe: number
  private readonly pIm: number
  private readonly out: number
  private readonly pBits: number
  private version = -1
  private last: TmccInfo
  private disposed = false

  constructor(mode: TransmissionMode, giRatio: number | null = null) {
    this.carriers = MODE_PARAMS[mode].tmccPerSegment
    this.pRe = wasmAlloc(wasm, this.carriers * 4)
    this.pIm = wasmAlloc(wasm, this.carriers * 4)
    this.out = wasmAlloc(wasm, INFO_FIELDS * 4)
    this.pBits = wasmAlloc(wasm, FRAME_BITS)
    this.state = (wasm.exports.tmcc_decoder_create as CreateFn)(mode, giRatio ?? -1)
    this.last = {
      locked: false,
      mode,
      guardIntervalRatio: giRatio,
      partialReception: false,
      systemDescriptor: null,
      layers: { A: null, B: null, C: null },
      frameCount: 0,
    }
  }

  get frameStartSymbol(): number {
    return (wasm.exports.tmcc_decoder_frame_start_symbol as FrameStartFn)(this.state)
  }

  reset(): void {
    ;(wasm.exports.tmcc_decoder_reset as StateFn)(this.state)
    this.version = -1
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ;(wasm.exports.tmcc_decoder_destroy as StateFn)(this.state)
    wasmFree(wasm, this.pRe, this.carriers * 4)
    wasmFree(wasm, this.pIm, this.carriers * 4)
    wasmFree(wasm, this.out, INFO_FIELDS * 4)
    wasmFree(wasm, this.pBits, FRAME_BITS)
  }

  push(re: Float32Array, im: Float32Array): TmccInfo {
    heap.f32(this.pRe, this.carriers).set(re.subarray(0, this.carriers))
    heap.f32(this.pIm, this.carriers).set(im.subarray(0, this.carriers))
    const updates = (wasm.exports.tmcc_decoder_push as PushFn)(this.state, this.pRe, this.pIm)
    if (updates === this.version) return this.last
    this.version = updates
    this.last = this.readInfo()
    return this.last
  }

  private readInfo(): TmccInfo {
    ;(wasm.exports.tmcc_decoder_write_info as WriteInfoFn)(this.state, this.out)
    ;(wasm.exports.tmcc_decoder_write_bits as WriteBitsFn)(this.state, this.pBits)
    const fields = new Uint32Array(wasm.memory.buffer, this.out, INFO_FIELDS)
    const rawBits = heap.u8(this.pBits, FRAME_BITS).slice()
    return {
      locked: fields[0] !== 0,
      partialReception: fields[1] !== 0,
      systemDescriptor: fields[2] === 0xffffffff ? null : fields[2],
      frameCount: fields[3],
      mode: fields[4] === 0 ? null : fields[4],
      guardIntervalRatio: fields[5] === 0 ? null : fields[5],
      layers: {
        A: readLayer(fields, 6),
        B: readLayer(fields, 11),
        C: readLayer(fields, 16),
      },
      rawBits,
    }
  }
}
