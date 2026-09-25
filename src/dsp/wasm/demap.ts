/**
 * WebAssembly channel estimation / demapping backend.
 *
 * Drop-in replacements for `estimateChannel`, `ChannelEstimator`, `equalize`,
 * `demodulatePlane` and `demodulatePlaneSoft`; see `wasm/demap/src/lib.rs`.
 */

import type { ComplexBins, ChannelEstimate } from '../stages/channelEstimation'
import type { ComplexPlane } from '../stages/carrierDemod'
import {
  CarrierModulation,
  MODE_PARAMS,
  centerSegmentCarrierOffset,
  pilotReference,
  type TransmissionMode,
} from '../isdbtParams'
import { wasmAlloc, wasmFree } from './loadWasm'
import { wasm, heap } from './dsp'

type EstimateChannelFn = (
  binsRe: number,
  binsIm: number,
  segPilotRef: number,
  outRe: number,
  outIm: number,
  symbolIndexInFrame: number,
  carriersPerSegment: number,
) => void

type EstimatorFn = (
  binsRe: number,
  binsIm: number,
  segPilotRef: number,
  outRe: number,
  outIm: number,
  prevRe: number,
  prevIm: number,
  hasPrev: number,
  symbolIndexInFrame: number,
  carriersPerSegment: number,
  alpha: number,
) => void

type EqualizeFn = (
  binsRe: number,
  binsIm: number,
  hRe: number,
  hIm: number,
  outRe: number,
  outIm: number,
  n: number,
) => void

type DemodulateFn = (
  modulation: number,
  currRe: number,
  currIm: number,
  prevRe: number,
  prevIm: number,
  hasPrev: number,
  out: number,
  n: number,
) => void

const segPilotRefCache = new Map<TransmissionMode, Float32Array>()

function segPilotReference(mode: TransmissionMode): Float32Array {
  const cached = segPilotRefCache.get(mode)
  if (cached) return cached
  const cps = MODE_PARAMS[mode].carriersPerSegment
  const active = pilotReference(MODE_PARAMS[mode].activeCarriers)
  const off = centerSegmentCarrierOffset(mode)
  const out = new Float32Array(cps)
  for (let k = 0; k < cps; k++) out[k] = active[off + k]
  segPilotRefCache.set(mode, out)
  return out
}

function bitsPerCarrier(modulation: CarrierModulation): number {
  switch (modulation) {
    case CarrierModulation.QPSK:
    case CarrierModulation.DQPSK:
      return 2
    case CarrierModulation.QAM16:
      return 4
    default:
      return 6
  }
}

/** Stateful estimator with one-pole temporal smoothing between symbols. */
export class WasmChannelEstimator {
  private readonly cps: number
  private readonly alpha: number
  private readonly pSegRef: number
  private readonly pBinsRe: number
  private readonly pBinsIm: number
  private readonly pOutRe: number
  private readonly pOutIm: number
  private readonly pPrevRe: number
  private readonly pPrevIm: number
  private hasPrev = false

  constructor(mode: TransmissionMode, alpha = 0.5) {
    const cps = MODE_PARAMS[mode].carriersPerSegment
    this.cps = cps
    this.alpha = alpha
    const bytes = cps * 4
    this.pSegRef = wasmAlloc(wasm, bytes)
    this.pBinsRe = wasmAlloc(wasm, bytes)
    this.pBinsIm = wasmAlloc(wasm, bytes)
    this.pOutRe = wasmAlloc(wasm, bytes)
    this.pOutIm = wasmAlloc(wasm, bytes)
    this.pPrevRe = wasmAlloc(wasm, bytes)
    this.pPrevIm = wasmAlloc(wasm, bytes)
    heap.f32(this.pSegRef, cps).set(segPilotReference(mode))
  }

  reset(): void {
    this.hasPrev = false
  }

  estimate(bins: ComplexBins, symbolIndexInFrame: number): ChannelEstimate {
    const n = this.cps
    heap.f32(this.pBinsRe, n).set(bins.re.subarray(0, n))
    heap.f32(this.pBinsIm, n).set(bins.im.subarray(0, n))
    ;(wasm.exports.demap_estimator_estimate as EstimatorFn)(
      this.pBinsRe,
      this.pBinsIm,
      this.pSegRef,
      this.pOutRe,
      this.pOutIm,
      this.pPrevRe,
      this.pPrevIm,
      this.hasPrev ? 1 : 0,
      symbolIndexInFrame,
      n,
      this.alpha,
    )
    this.hasPrev = true
    return {
      re: heap.f32(this.pOutRe, n).slice(),
      im: heap.f32(this.pOutIm, n).slice(),
    }
  }

  dispose(): void {
    const bytes = this.cps * 4
    for (const p of [
      this.pSegRef,
      this.pBinsRe,
      this.pBinsIm,
      this.pOutRe,
      this.pOutIm,
      this.pPrevRe,
      this.pPrevIm,
    ]) {
      wasmFree(wasm, p, bytes)
    }
  }
}

type ProcessSymbolFn = (
  fftRe: number,
  fftIm: number,
  fftSize: number,
  carrierBase: number,
  binsRe: number,
  binsIm: number,
  segPilotRef: number,
  hRe: number,
  hIm: number,
  prevRe: number,
  prevIm: number,
  hasPrev: number,
  symbolIndexInFrame: number,
  carriersPerSegment: number,
  alpha: number,
  dataIdx: number,
  dataCount: number,
  outRe: number,
  outIm: number,
) => void

/**
 * Fused per-symbol demapper: extracts the center-segment carriers, estimates the
 * channel and equalizes only the data carriers, writing them contiguously into a
 * caller-provided destination. Reuses all WASM scratch across symbols.
 */
export class WasmSymbolDemapper {
  private readonly cps: number
  private readonly dataCount: number
  private readonly alpha: number
  private readonly pSegRef: number
  private readonly pBinsRe: number
  private readonly pBinsIm: number
  private readonly pHRe: number
  private readonly pHIm: number
  private readonly pPrevRe: number
  private readonly pPrevIm: number
  private readonly pOutRe: number
  private readonly pOutIm: number
  private readonly dataPtrs: number[]
  private fftCap = 0
  private pFftRe = 0
  private pFftIm = 0
  private hasPrev = false

  constructor(mode: TransmissionMode, dataIndices: readonly (readonly number[])[], alpha = 1) {
    const cps = MODE_PARAMS[mode].carriersPerSegment
    this.cps = cps
    this.dataCount = MODE_PARAMS[mode].dataCarriersPerSegment
    this.alpha = alpha
    const bytes = cps * 4
    this.pSegRef = wasmAlloc(wasm, bytes)
    this.pBinsRe = wasmAlloc(wasm, bytes)
    this.pBinsIm = wasmAlloc(wasm, bytes)
    this.pHRe = wasmAlloc(wasm, bytes)
    this.pHIm = wasmAlloc(wasm, bytes)
    this.pPrevRe = wasmAlloc(wasm, bytes)
    this.pPrevIm = wasmAlloc(wasm, bytes)
    heap.f32(this.pSegRef, cps).set(segPilotReference(mode))
    const dataBytes = this.dataCount * 4
    this.dataPtrs = dataIndices.map((idx) => {
      const ptr = wasmAlloc(wasm, dataBytes)
      new Uint32Array(wasm.memory.buffer, ptr, this.dataCount).set(idx)
      return ptr
    })
    this.pOutRe = wasmAlloc(wasm, dataBytes)
    this.pOutIm = wasmAlloc(wasm, dataBytes)
  }

  reset(): void {
    this.hasPrev = false
  }

  /** Process one symbol and append the equalized data carriers at `outOffset`. */
  process(
    fftRe: Float32Array,
    fftIm: Float32Array,
    fftSize: number,
    carrierBase: number,
    phase: number,
    symbolIndexInFrame: number,
    outRe: Float32Array,
    outIm: Float32Array,
    outOffset: number,
  ): void {
    if (fftSize > this.fftCap) {
      if (this.fftCap > 0) {
        wasmFree(wasm, this.pFftRe, this.fftCap * 4)
        wasmFree(wasm, this.pFftIm, this.fftCap * 4)
      }
      this.pFftRe = wasmAlloc(wasm, fftSize * 4)
      this.pFftIm = wasmAlloc(wasm, fftSize * 4)
      this.fftCap = fftSize
    }
    heap.f32(this.pFftRe, fftSize).set(fftRe.subarray(0, fftSize))
    heap.f32(this.pFftIm, fftSize).set(fftIm.subarray(0, fftSize))
    ;(wasm.exports.demap_process_symbol as ProcessSymbolFn)(
      this.pFftRe,
      this.pFftIm,
      fftSize,
      carrierBase,
      this.pBinsRe,
      this.pBinsIm,
      this.pSegRef,
      this.pHRe,
      this.pHIm,
      this.pPrevRe,
      this.pPrevIm,
      this.hasPrev ? 1 : 0,
      symbolIndexInFrame,
      this.cps,
      this.alpha,
      this.dataPtrs[phase],
      this.dataCount,
      this.pOutRe,
      this.pOutIm,
    )
    this.hasPrev = true
    outRe.set(heap.f32(this.pOutRe, this.dataCount), outOffset)
    outIm.set(heap.f32(this.pOutIm, this.dataCount), outOffset)
  }

  dispose(): void {
    const bytes = this.cps * 4
    for (const p of [
      this.pSegRef,
      this.pBinsRe,
      this.pBinsIm,
      this.pHRe,
      this.pHIm,
      this.pPrevRe,
      this.pPrevIm,
    ]) {
      wasmFree(wasm, p, bytes)
    }
    const dataBytes = this.dataCount * 4
    for (const p of [...this.dataPtrs, this.pOutRe, this.pOutIm]) wasmFree(wasm, p, dataBytes)
    if (this.fftCap > 0) {
      wasmFree(wasm, this.pFftRe, this.fftCap * 4)
      wasmFree(wasm, this.pFftIm, this.fftCap * 4)
      this.fftCap = 0
    }
  }
}

export function estimateChannelWasm(
  bins: ComplexBins,
  symbolIndexInFrame: number,
  mode: TransmissionMode,
): ChannelEstimate {
  const cps = MODE_PARAMS[mode].carriersPerSegment
  const bytes = cps * 4
  const pSegRef = wasmAlloc(wasm, bytes)
  const pBinsRe = wasmAlloc(wasm, bytes)
  const pBinsIm = wasmAlloc(wasm, bytes)
  const pOutRe = wasmAlloc(wasm, bytes)
  const pOutIm = wasmAlloc(wasm, bytes)
  try {
    heap.f32(pSegRef, cps).set(segPilotReference(mode))
    heap.f32(pBinsRe, cps).set(bins.re.subarray(0, cps))
    heap.f32(pBinsIm, cps).set(bins.im.subarray(0, cps))
    ;(wasm.exports.demap_estimate_channel as EstimateChannelFn)(
      pBinsRe,
      pBinsIm,
      pSegRef,
      pOutRe,
      pOutIm,
      symbolIndexInFrame,
      cps,
    )
    return {
      re: heap.f32(pOutRe, cps).slice(),
      im: heap.f32(pOutIm, cps).slice(),
    }
  } finally {
    for (const p of [pSegRef, pBinsRe, pBinsIm, pOutRe, pOutIm]) wasmFree(wasm, p, bytes)
  }
}

export function equalizeWasm(bins: ComplexBins, h: ChannelEstimate): ComplexBins {
  const n = bins.re.length
  const bytes = n * 4
  const pBinsRe = wasmAlloc(wasm, bytes)
  const pBinsIm = wasmAlloc(wasm, bytes)
  const pHRe = wasmAlloc(wasm, bytes)
  const pHIm = wasmAlloc(wasm, bytes)
  const pOutRe = wasmAlloc(wasm, bytes)
  const pOutIm = wasmAlloc(wasm, bytes)
  try {
    heap.f32(pBinsRe, n).set(bins.re)
    heap.f32(pBinsIm, n).set(bins.im)
    heap.f32(pHRe, n).set(h.re.subarray(0, n))
    heap.f32(pHIm, n).set(h.im.subarray(0, n))
    ;(wasm.exports.demap_equalize as EqualizeFn)(pBinsRe, pBinsIm, pHRe, pHIm, pOutRe, pOutIm, n)
    return { re: heap.f32(pOutRe, n).slice(), im: heap.f32(pOutIm, n).slice() }
  } finally {
    for (const p of [pBinsRe, pBinsIm, pHRe, pHIm, pOutRe, pOutIm]) wasmFree(wasm, p, bytes)
  }
}

export function demodulatePlaneWasm(
  modulation: CarrierModulation,
  curr: ComplexPlane,
  prev: ComplexPlane | null,
): Uint8Array {
  const n = curr.re.length
  if (modulation === CarrierModulation.DQPSK && prev === null) {
    throw new Error('DQPSK demodulation requires the previous symbol plane')
  }
  const bytes = n * 4
  const pCurrRe = wasmAlloc(wasm, bytes)
  const pCurrIm = wasmAlloc(wasm, bytes)
  const pPrevRe = prev ? wasmAlloc(wasm, bytes) : 0
  const pPrevIm = prev ? wasmAlloc(wasm, bytes) : 0
  const pOut = wasmAlloc(wasm, n)
  try {
    heap.f32(pCurrRe, n).set(curr.re)
    heap.f32(pCurrIm, n).set(curr.im)
    if (prev) {
      heap.f32(pPrevRe, n).set(prev.re.subarray(0, n))
      heap.f32(pPrevIm, n).set(prev.im.subarray(0, n))
    }
    ;(wasm.exports.demap_demodulate as DemodulateFn)(
      modulation,
      pCurrRe,
      pCurrIm,
      pPrevRe,
      pPrevIm,
      prev ? 1 : 0,
      pOut,
      n,
    )
    return heap.u8(pOut, n).slice()
  } finally {
    if (prev) {
      wasmFree(wasm, pPrevRe, bytes)
      wasmFree(wasm, pPrevIm, bytes)
    }
    for (const p of [pCurrRe, pCurrIm]) wasmFree(wasm, p, bytes)
    wasmFree(wasm, pOut, n)
  }
}

interface SoftDemapScratch {
  inCap: number
  outCap: number
  pCurrRe: number
  pCurrIm: number
  pPrevRe: number
  pPrevIm: number
  pOut: number
}

let softDemapScratch: SoftDemapScratch | null = null

function ensureSoftDemapScratch(n: number, outBytes: number): SoftDemapScratch {
  const s = softDemapScratch ?? {
    inCap: 0,
    outCap: 0,
    pCurrRe: 0,
    pCurrIm: 0,
    pPrevRe: 0,
    pPrevIm: 0,
    pOut: 0,
  }
  softDemapScratch = s
  if (n > s.inCap) {
    if (s.inCap > 0) {
      const bytes = s.inCap * 4
      for (const p of [s.pCurrRe, s.pCurrIm, s.pPrevRe, s.pPrevIm]) wasmFree(wasm, p, bytes)
    }
    s.pCurrRe = wasmAlloc(wasm, n * 4)
    s.pCurrIm = wasmAlloc(wasm, n * 4)
    s.pPrevRe = wasmAlloc(wasm, n * 4)
    s.pPrevIm = wasmAlloc(wasm, n * 4)
    s.inCap = n
  }
  if (outBytes > s.outCap) {
    if (s.outCap > 0) wasmFree(wasm, s.pOut, s.outCap)
    s.pOut = wasmAlloc(wasm, outBytes)
    s.outCap = outBytes
  }
  return s
}

export function demodulatePlaneSoftWasm(
  modulation: CarrierModulation,
  curr: ComplexPlane,
  prev: ComplexPlane | null,
): Int8Array {
  const n = curr.re.length
  if (modulation === CarrierModulation.DQPSK && prev === null) {
    throw new Error('DQPSK demodulation requires the previous symbol plane')
  }
  const bits = bitsPerCarrier(modulation)
  const s = ensureSoftDemapScratch(n, n * bits)
  heap.f32(s.pCurrRe, n).set(curr.re)
  heap.f32(s.pCurrIm, n).set(curr.im)
  if (prev) {
    heap.f32(s.pPrevRe, n).set(prev.re.subarray(0, n))
    heap.f32(s.pPrevIm, n).set(prev.im.subarray(0, n))
  }
  ;(wasm.exports.demap_demodulate_soft as DemodulateFn)(
    modulation,
    s.pCurrRe,
    s.pCurrIm,
    prev ? s.pPrevRe : 0,
    prev ? s.pPrevIm : 0,
    prev ? 1 : 0,
    s.pOut,
    n,
  )
  return heap.i8(s.pOut, n * bits).slice()
}
