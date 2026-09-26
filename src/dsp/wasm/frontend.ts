/**
 * WebAssembly fused locked-state front end.
 *
 * Wraps `wasm/dsp/src/frontend.rs`: a stateful object that owns the sample
 * buffer, NCO derotation, tracking synchronizer, FFT, TMCC decoder and
 * channel estimation/equalization/demapping. Samples are fed per host chunk and
 * equalized data-carrier planes accumulate in linear memory.
 */

import type { TransmissionMode } from '../isdbtParams'
import type { TmccInfo, TmccLayerInfo } from '../../models/tmcc'
import { wasmAlloc, wasmFree } from './loadWasm'
import { wasm, heap } from './dsp'

const INFO_FIELDS = 21
const FRAME_BITS = 204
const STATS_FIELDS = 5

type CreateFn = (
  mode: number,
  fftSize: number,
  gi: number,
  sampleRateHz: number,
  carrierBase: number,
  fractionalOffsetHz: number,
  spOffset: number,
  frameStartSymbol: number,
  alpha: number,
  cps: number,
  dc: number,
  segRefPtr: number,
  dataIdxPtr: number,
  tmccPtr: number,
  tmccCount: number,
) => number

type PushFn = (state: number, rePtr: number, imPtr: number, len: number) => number
type PtrFn = (state: number) => number
type CountFn = (state: number) => number
type StateFn = (state: number) => void
type WriteFn = (state: number, out: number) => void

export interface FrontendParams {
  mode: TransmissionMode
  fftSize: number
  gi: number
  sampleRate: number
  carrierBase: number
  fractionalOffsetHz: number
  spOffset: number
  frameStartSymbol: number
  alpha?: number
  carriersPerSegment: number
  dataCount: number
  segRef: Float32Array
  dataIndices: readonly (readonly number[])[]
  tmccCarriers: readonly number[]
}

export interface FrontendStats {
  gammaMagnitude: number
  phi: number
  signalPower: number
  merDb: number | null
  symbolsProcessed: number
}

function readLayer(fields: Uint32Array, base: number): TmccLayerInfo | null {
  if (fields[base] === 0) return null
  return {
    modulation: fields[base + 1],
    codeRate: fields[base + 2],
    timeInterleave: fields[base + 3],
    segments: fields[base + 4],
  }
}

export class WasmFrontend {
  readonly dataCount: number
  private readonly state: number
  private readonly segmentRef: number
  private readonly dataIndex: number
  private readonly tmccIndex: number
  private readonly statsOut: number
  private readonly infoOut: number
  private readonly bitsOut: number
  private readonly segmentBytes: number
  private readonly dataBytes: number
  private readonly tmccBytes: number
  private tmccVersion = -1
  private lastTmcc: TmccInfo
  private inCap = 0
  private pInRe = 0
  private pInIm = 0
  private disposed = false

  constructor(params: FrontendParams) {
    this.dataCount = params.dataCount
    const { carriersPerSegment: cps, dataCount: dc } = params
    const tmccCount = params.tmccCarriers.length

    this.segmentBytes = cps * 4
    this.dataBytes = 4 * dc * 4
    this.tmccBytes = tmccCount * 4
    this.segmentRef = wasmAlloc(wasm, this.segmentBytes)
    this.dataIndex = wasmAlloc(wasm, this.dataBytes)
    this.tmccIndex = wasmAlloc(wasm, this.tmccBytes)
    this.statsOut = wasmAlloc(wasm, STATS_FIELDS * 8)
    this.infoOut = wasmAlloc(wasm, INFO_FIELDS * 4)
    this.bitsOut = wasmAlloc(wasm, FRAME_BITS)

    heap.f32(this.segmentRef, cps).set(params.segRef.subarray(0, cps))
    const dataFlat = new Uint32Array(wasm.memory.buffer, this.dataIndex, 4 * dc)
    for (let phase = 0; phase < 4; phase++) {
      dataFlat.set(params.dataIndices[phase].slice(0, dc), phase * dc)
    }
    new Uint32Array(wasm.memory.buffer, this.tmccIndex, tmccCount).set(params.tmccCarriers)

    this.state = (wasm.exports.frontend_create as CreateFn)(
      params.mode,
      params.fftSize,
      params.gi,
      params.sampleRate,
      params.carrierBase,
      params.fractionalOffsetHz,
      params.spOffset,
      params.frameStartSymbol,
      params.alpha ?? 1,
      cps,
      dc,
      this.segmentRef,
      this.dataIndex,
      this.tmccIndex,
      tmccCount,
    )
    this.lastTmcc = {
      locked: false,
      mode: params.mode,
      guardIntervalRatio: params.gi,
      partialReception: false,
      systemDescriptor: null,
      layers: { A: null, B: null, C: null },
      frameCount: 0,
    }
  }

  /** Append resampled complex samples and return the pending symbol count. */
  push(re: Float32Array, im: Float32Array): number {
    const len = re.length
    if (len > this.inCap) {
      this.freeInputs()
      this.pInRe = wasmAlloc(wasm, len * 4)
      this.pInIm = wasmAlloc(wasm, len * 4)
      this.inCap = len
    }
    heap.f32(this.pInRe, len).set(re)
    heap.f32(this.pInIm, len).set(im)
    return (wasm.exports.frontend_push as PushFn)(this.state, this.pInRe, this.pInIm, len)
  }

  /**
   * Append samples that already live in this WASM instance (for example the
   * decimator or resampler output) without staging them through the host.
   */
  pushPointers(rePtr: number, imPtr: number, len: number): number {
    return (wasm.exports.frontend_push as PushFn)(this.state, rePtr, imPtr, len)
  }

  pendingCount(): number {
    return (wasm.exports.frontend_pending_count as CountFn)(this.state)
  }

  pendingRe(): Float32Array {
    const ptr = (wasm.exports.frontend_pending_re as PtrFn)(this.state)
    return heap.f32(ptr, this.pendingCount() * this.dataCount)
  }

  pendingIm(): Float32Array {
    const ptr = (wasm.exports.frontend_pending_im as PtrFn)(this.state)
    return heap.f32(ptr, this.pendingCount() * this.dataCount)
  }

  /**
   * Location of the pending equalized planes in WASM. `length` counts complex
   * values (`symbolCount * dataCount`). Valid until the next push/clear/reset.
   */
  pendingPointers(): { rePtr: number; imPtr: number; length: number } {
    const count = this.pendingCount()
    const rePtr = (wasm.exports.frontend_pending_re as PtrFn)(this.state)
    const imPtr = (wasm.exports.frontend_pending_im as PtrFn)(this.state)
    return { rePtr, imPtr, length: count * this.dataCount }
  }

  clearPending(): void {
    ;(wasm.exports.frontend_clear_pending as StateFn)(this.state)
  }

  stats(): FrontendStats {
    ;(wasm.exports.frontend_write_stats as WriteFn)(this.state, this.statsOut)
    const fields = heap.f64(this.statsOut, STATS_FIELDS)
    const merDb = fields[3]
    return {
      gammaMagnitude: fields[0],
      phi: fields[1],
      signalPower: fields[2],
      merDb: Number.isNaN(merDb) ? null : merDb,
      symbolsProcessed: fields[4],
    }
  }

  tmccInfo(): TmccInfo {
    const version = (wasm.exports.frontend_tmcc_version as CountFn)(this.state)
    if (version === this.tmccVersion) return this.lastTmcc
    this.tmccVersion = version
    ;(wasm.exports.frontend_write_tmcc as WriteFn)(this.state, this.infoOut)
    ;(wasm.exports.frontend_write_tmcc_bits as WriteFn)(this.state, this.bitsOut)
    const fields = new Uint32Array(wasm.memory.buffer, this.infoOut, INFO_FIELDS)
    this.lastTmcc = {
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
      rawBits: heap.u8(this.bitsOut, FRAME_BITS).slice(),
    }
    return this.lastTmcc
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ;(wasm.exports.frontend_destroy as StateFn)(this.state)
    this.freeInputs()
    wasmFree(wasm, this.segmentRef, this.segmentBytes)
    wasmFree(wasm, this.dataIndex, this.dataBytes)
    wasmFree(wasm, this.tmccIndex, this.tmccBytes)
    wasmFree(wasm, this.statsOut, STATS_FIELDS * 8)
    wasmFree(wasm, this.infoOut, INFO_FIELDS * 4)
    wasmFree(wasm, this.bitsOut, FRAME_BITS)
  }

  private freeInputs(): void {
    if (this.inCap === 0) return
    wasmFree(wasm, this.pInRe, this.inCap * 4)
    wasmFree(wasm, this.pInIm, this.inCap * 4)
    this.pInRe = 0
    this.pInIm = 0
    this.inCap = 0
  }
}
