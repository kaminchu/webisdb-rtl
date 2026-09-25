/**
 * One-seg receive pipeline: raw U8 IQ -> MPEG-TS bytes.
 *
 * Chain: U8 -> complex -> DC removal -> fractional resample to 64/63 MSps ->
 * GI-correlation synchronisation -> fine CFO -> one-seg FFT -> center-segment
 * carrier extraction -> integer-CFO alignment -> TMCC decode -> channel
 * estimation/equalisation -> OneSegDecoder -> TS.
 *
 * Acquisition starts from Mode 3 / GI 1/8 and falls back through all mode x GI
 * combinations. The integer carrier offset (the full-seg capture is often several
 * hundred carriers off-centre) is found with a CFO-invariant BPSK metric on the
 * known TMCC carriers, then applied as an extraction-base shift.
 */

import {
  MODE_PARAMS,
  ONESEG_SAMPLING_HZ,
  oneSegTmccCarriers,
  scatteredPilotIndices,
  type TransmissionMode,
} from './isdbtParams'
import type { IqChunk } from '../iq/IQSource'
import type { ReceptionQuality } from '../models/reception'
import type { TmccInfo } from '../models/tmcc'
import { pilotReferenceAt, type ComplexBins } from './stages/channelEstimation'
import { OneSegDecoder } from './oneSegDecoder'
import { WasmFftBackend } from './wasm/fft'
import { segPilotReference } from './wasm/demap'
import { WasmFrontend } from './wasm/frontend'
import { WasmOfdmSynchronizer } from './wasm/ofdm'
import { WasmTmccDecoder } from './wasm/tmcc'
import { WasmDcRemoval, WasmFractionalResampler, WasmNcoCorrector } from './wasm/resample'

export type PipelineState = 'idle' | 'acquiring' | 'locked' | 'error'

export interface OneSegPipelineStats {
  state: PipelineState
  quality: ReceptionQuality
  mode: number | null
  guardIntervalRatio: number | null
  /** Integer carrier offset applied to the extraction base. */
  carrierOffset: number | null
  symbolsProcessed: number
  tsBytes: number
  bufferedSamples: number
}

export interface OneSegPipelineCallbacks {
  onTs?(bytes: Uint8Array): void
  onTmcc?(info: TmccInfo): void
  onStats?(stats: OneSegPipelineStats): void
  onState?(state: PipelineState): void
}

export interface OneSegPipelineOptions {
  /** Source sample rate of the U8 chunks (default 1.2 MSps). */
  sourceSampleRate?: number
  /** Resampler low-pass cutoff in Hz (default 450 kHz). */
  cutoffHz?: number
  /** Re-acquire after this long without new TS while locked (default 1500 ms). */
  lockStallMs?: number
  /** Monotonic clock in milliseconds; overridable for tests. */
  clock?: () => number
}

const ACQUIRE_MIN_SAMPLES = 750_000
const ACQUIRE_MAX_SYMBOLS = 900
const TMCC_CFO_RANGE = 320
const DEFAULT_LOCK_STALL_MS = 1500

const CANDIDATES: readonly (readonly [TransmissionMode, number])[] = [
  [3, 8],
  [3, 4],
  [3, 16],
  [3, 32],
  [2, 8],
  [2, 4],
  [2, 16],
  [2, 32],
  [1, 8],
  [1, 4],
  [1, 16],
  [1, 32],
]

/** Center-segment AC (auxiliary channel) carrier positions per mode. */
const ONESEG_AC: Record<TransmissionMode, readonly number[]> = {
  1: [35, 79],
  2: [98, 101, 118, 136],
  3: [7, 89, 206, 209, 226, 244, 377, 407],
}

function dataCarrierIndices(mode: TransmissionMode, symbolIndexInFrame: number): number[] {
  const cps = MODE_PARAMS[mode].carriersPerSegment
  const exclude = new Set<number>(scatteredPilotIndices(symbolIndexInFrame, cps))
  for (const c of tmccCarriersFor(mode)) exclude.add(c)
  for (const c of ONESEG_AC[mode]) exclude.add(c)
  const out: number[] = []
  for (let c = 0; c < cps; c++) if (!exclude.has(c)) out.push(c)
  return out
}

const dataCarrierCache = new Map<string, number[]>()
function dataCarriersFor(mode: TransmissionMode, symbolIndexInFrame: number): number[] {
  const phase = ((symbolIndexInFrame % 4) + 4) % 4
  const key = `${mode}:${phase}`
  let v = dataCarrierCache.get(key)
  if (!v) {
    v = dataCarrierIndices(mode, phase)
    dataCarrierCache.set(key, v)
  }
  return v
}

const tmccCarrierCache = new Map<TransmissionMode, readonly number[]>()
function tmccCarriersFor(mode: TransmissionMode): readonly number[] {
  let v = tmccCarrierCache.get(mode)
  if (!v) {
    v = oneSegTmccCarriers(mode)
    tmccCarrierCache.set(mode, v)
  }
  return v
}

/**
 * Integer-CFO search over the TMCC carriers.
 *
 * The BPSK concentration for shift `m` sums the doubled phase of
 * `z_s[c] * conj(z_{s-1}[c])` over all symbols `s` and TMCC carriers `k`, where
 * `c = half + m + k`. The term depends only on the FFT bin `c`, not on `m`, so
 * the per-bin doubled phasors are accumulated once and each shift then reduces
 * to a short sum over the (few) TMCC carriers. This turns the naive
 * `O(shifts * symbols * carriers)` search into `O(bins * symbols)`.
 */
function estimateIntegerCfo(
  planes: readonly ComplexBins[],
  mode: TransmissionMode,
): { m: number; score: number }[] {
  const half = MODE_PARAMS[mode].oneSegFftSize >> 1
  const tmcc = tmccCarriersFor(mode)
  const n = planes.length > 0 ? planes[0].re.length : 0
  if (n === 0 || tmcc.length === 0) return []

  const lo = Math.max(0, half - TMCC_CFO_RANGE + tmcc[0])
  const hi = Math.min(n, half + TMCC_CFO_RANGE + tmcc[tmcc.length - 1] + 1)
  const accRe = new Float64Array(n)
  const accIm = new Float64Array(n)
  const counts = new Float64Array(n)
  for (let s = 1; s < planes.length; s++) {
    const curRe = planes[s].re
    const curIm = planes[s].im
    const prevRe = planes[s - 1].re
    const prevIm = planes[s - 1].im
    for (let c = lo; c < hi; c++) {
      const dr = curRe[c] * prevRe[c] + curIm[c] * prevIm[c]
      const di = curIm[c] * prevRe[c] - curRe[c] * prevIm[c]
      const mag = Math.sqrt(dr * dr + di * di)
      if (mag < 1e-9) continue
      const cosd = dr / mag
      const sind = di / mag
      accRe[c] += cosd * cosd - sind * sind
      accIm[c] += 2 * cosd * sind
      counts[c] += 1
    }
  }

  const scored: { m: number; score: number }[] = []
  for (let m = -TMCC_CFO_RANGE; m <= TMCC_CFO_RANGE; m++) {
    let sr = 0
    let si = 0
    let count = 0
    for (const k of tmcc) {
      const c = half + m + k
      if (c < 0 || c >= n) continue
      sr += accRe[c]
      si += accIm[c]
      count += counts[c]
    }
    scored.push({ m, score: count > 0 ? Math.hypot(sr, si) / count : 0 })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 4)
}

const scatteredPilotCache = new Map<string, readonly number[]>()
function scatteredPilotsFor(mode: TransmissionMode, phase: number): readonly number[] {
  const key = `${mode}:${phase}`
  let v = scatteredPilotCache.get(key)
  if (!v) {
    v = scatteredPilotIndices(phase, MODE_PARAMS[mode].carriersPerSegment)
    scatteredPilotCache.set(key, v)
  }
  return v
}

/**
 * Find the OFDM frame phase (0..3) whose scattered-pilot positions carry the
 * boosted pilot amplitude. `planes[s]` is symbol `s`; the returned offset means
 * symbol `s` uses `scatteredPilotIndices((s + offset) % 4)`.
 */
function estimateSpPhase(
  planes: readonly ComplexBins[],
  mode: TransmissionMode,
  m: number,
): number {
  const n = planes[0].re.length
  const half = MODE_PARAMS[mode].oneSegFftSize >> 1
  const cps = MODE_PARAMS[mode].carriersPerSegment
  const pilots = [0, 1, 2, 3].map((phase) => scatteredPilotsFor(mode, phase))
  const refInv = new Float64Array(cps)
  for (let c = 0; c < cps; c++) refInv[c] = 1 / pilotReferenceAt(c, mode)
  let best = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let offset = 0; offset < 4; offset++) {
    let variation = 0
    let power = 0
    for (let s = 0; s < planes.length; s++) {
      const re = planes[s].re
      const im = planes[s].im
      let prevRe = 0
      let prevIm = 0
      let havePrev = false
      for (const c of pilots[(s + offset) & 3]) {
        const bin = half + m + c
        if (bin < 0 || bin >= n) continue
        const inv = refInv[c]
        const hr = re[bin] * inv
        const hi = im[bin] * inv
        if (havePrev) {
          const dr = hr - prevRe
          const di = hi - prevIm
          variation += dr * dr + di * di
          power += prevRe * prevRe + prevIm * prevIm
        }
        prevRe = hr
        prevIm = hi
        havePrev = true
      }
    }
    const score = power > 0 ? variation / power : Number.POSITIVE_INFINITY
    if (score < bestScore) {
      bestScore = score
      best = offset
    }
  }
  return best
}

export class OneSegPipeline {
  private readonly callbacks: OneSegPipelineCallbacks
  private readonly options: Required<Pick<OneSegPipelineOptions, 'sourceSampleRate' | 'cutoffHz'>>
  private readonly lockStallMs: number
  private readonly clock: () => number
  private readonly dc = new WasmDcRemoval(0.001)
  private resampler: WasmFractionalResampler
  private readonly fft = new WasmFftBackend()

  private state: PipelineState = 'idle'
  private bufRe = new Float32Array(1 << 20)
  private bufIm = new Float32Array(1 << 20)
  private inRe = new Float32Array(0)
  private inIm = new Float32Array(0)
  private bufLen = 0
  private lastAcquireLen = 0
  private acqRe = new Float32Array(0)
  private acqIm = new Float32Array(0)
  private acqBatchRe = new Float32Array(0)
  private acqBatchIm = new Float32Array(0)
  private readonly planePool: ComplexBins[] = []

  private mode: TransmissionMode | null = null
  private gi: number | null = null
  private integerCarrierOffset = 0
  private fractionalOffsetHz: number | null = null

  private frontend: WasmFrontend | null = null
  private oneSeg: OneSegDecoder | null = null
  private tmccInfo: TmccInfo | null = null
  private frontendSymbolBase = 0
  private symbolsProcessed = 0
  private tsBytes = 0
  private lastGammaMag = 0
  private lastPhi = 0
  private lastSignalPower = 0
  private lastMerDb: number | null = null
  private lastProgressAt = 0
  private lastProgressTsBytes = 0

  constructor(callbacks: OneSegPipelineCallbacks = {}, options: OneSegPipelineOptions = {}) {
    this.callbacks = callbacks
    this.options = {
      sourceSampleRate: options.sourceSampleRate ?? 1_200_000,
      cutoffHz: options.cutoffHz ?? 450_000,
    }
    this.lockStallMs = options.lockStallMs ?? DEFAULT_LOCK_STALL_MS
    this.clock =
      options.clock ??
      (typeof performance !== 'undefined' ? () => performance.now() : () => Date.now())
    this.resampler = new WasmFractionalResampler(
      this.options.sourceSampleRate,
      ONESEG_SAMPLING_HZ,
      this.options.cutoffHz,
    )
  }

  /** Feed one raw IQ chunk (U8/I8 interleaved, or F32 complex interleaved). */
  pushIq(chunk: IqChunk): void {
    const count = Math.floor(chunk.data.length / 2)
    if (count > this.inRe.length) {
      this.inRe = new Float32Array(count)
      this.inIm = new Float32Array(count)
    }
    const re = this.inRe.subarray(0, count)
    const im = this.inIm.subarray(0, count)
    const data = chunk.data
    if (chunk.format === 'u8') {
      const u8 = data instanceof Uint8Array ? data : Uint8Array.from(data as ArrayLike<number>)
      const scale = 1 / 127.5
      for (let i = 0; i < count; i++) {
        re[i] = (u8[2 * i] - 127.5) * scale
        im[i] = (u8[2 * i + 1] - 127.5) * scale
      }
    } else if (chunk.format === 'i8') {
      for (let i = 0; i < count; i++) {
        re[i] = Number(data[2 * i]) / 128
        im[i] = Number(data[2 * i + 1]) / 128
      }
    } else {
      for (let i = 0; i < count; i++) {
        re[i] = Number(data[2 * i])
        im[i] = Number(data[2 * i + 1])
      }
    }

    this.dc.process(re, im)
    const rs = this.resampler.process(re, im)

    if (this.state === 'locked') {
      this.processLocked(rs.re, rs.im)
      this.checkLockLoss()
    } else {
      this.append(rs.re, rs.im)
      if (this.state === 'idle') this.setState('acquiring')
      if (
        this.bufLen >= ACQUIRE_MIN_SAMPLES &&
        this.bufLen >= this.lastAcquireLen + ACQUIRE_MIN_SAMPLES
      ) {
        this.lastAcquireLen = this.bufLen
        this.tryAcquire()
      }
    }
    this.emitStats()
  }

  /**
   * A locked pipeline free-runs: if the signal degrades, symbol starts keep
   * coming from the tracking synchronizer but FEC fails, so TS stops without an
   * error. Fall back to acquisition once output has stalled so a dropout can
   * recover instead of freezing playback forever.
   */
  private checkLockLoss(): void {
    if (this.tsBytes !== this.lastProgressTsBytes) {
      this.lastProgressTsBytes = this.tsBytes
      this.lastProgressAt = this.clock()
      return
    }
    if (this.clock() - this.lastProgressAt > this.lockStallMs) this.releaseLock()
  }

  private releaseLock(): void {
    this.frontend?.dispose()
    this.oneSeg?.dispose()
    this.frontend = null
    this.oneSeg = null
    this.tmccInfo = null
    this.mode = null
    this.gi = null
    this.integerCarrierOffset = 0
    this.fractionalOffsetHz = null
    this.frontendSymbolBase = 0
    // Buffered samples were consumed by the locked front end; discard them so the
    // new acquisition applies its own frequency correction to fresh samples.
    this.bufLen = 0
    this.lastAcquireLen = 0
    this.setState('acquiring')
  }

  /** Force acquisition with whatever is buffered and flush pending TS. */
  flush(): void {
    if (this.state !== 'locked') {
      if (this.bufLen > 0) {
        this.lastAcquireLen = this.bufLen
        this.tryAcquire()
      }
    }
    if (this.state === 'locked') {
      this.applyFrontendStats()
      this.drainFrontend()
    }
    this.emitStats()
  }

  /** Drop buffered samples and reset all DSP state. */
  discardBuffer(): void {
    this.bufLen = 0
    this.lastAcquireLen = 0
    this.dc.reset()
    this.resampler.reset()
    this.frontend?.dispose()
    this.oneSeg?.dispose()
    this.frontend = null
    this.oneSeg = null
    this.tmccInfo = null
    this.mode = null
    this.gi = null
    this.integerCarrierOffset = 0
    this.fractionalOffsetHz = null
    this.frontendSymbolBase = 0
    this.lastProgressAt = this.clock()
    this.lastProgressTsBytes = this.tsBytes
    this.setState('idle')
  }

  reset(): void {
    this.discardBuffer()
    this.symbolsProcessed = 0
    this.tsBytes = 0
    this.lastGammaMag = 0
    this.lastPhi = 0
    this.lastSignalPower = 0
    this.lastMerDb = null
    this.emitStats()
  }

  /** Release all WASM state; the pipeline must not be used afterwards. */
  dispose(): void {
    this.discardBuffer()
    this.dc.dispose()
    this.resampler.dispose()
    this.fft.dispose()
  }

  private tryAcquire(): boolean {
    for (const [mode, gi] of CANDIDATES) {
      const n = MODE_PARAMS[mode].oneSegFftSize
      const sync = new WasmOfdmSynchronizer(n, gi, ONESEG_SAMPLING_HZ)
      try {
        const res = sync.process(
          this.bufRe.subarray(0, this.bufLen),
          this.bufIm.subarray(0, this.bufLen),
        )
        if (res.symbolStarts.length < 260) continue
        this.lastGammaMag = res.gammaMagnitude
        this.lastPhi = res.phi

        if (this.acqRe.length < this.bufLen) {
          this.acqRe = new Float32Array(this.bufLen)
          this.acqIm = new Float32Array(this.bufLen)
        }
        this.acqRe.set(this.bufRe.subarray(0, this.bufLen))
        this.acqIm.set(this.bufIm.subarray(0, this.bufLen))
        const cRe = this.acqRe
        const cIm = this.acqIm
        const fFrac = res.fractionalOffsetHz ?? 0
        const nco = new WasmNcoCorrector(fFrac, ONESEG_SAMPLING_HZ)
        nco.process(cRe, cIm)
        nco.dispose()

        const planes = this.extractFullPlanes(cRe, cIm, res.symbolStarts, n)
        if (planes.length < 260) continue

        const candidates = estimateIntegerCfo(planes, mode)
        for (const { m, score } of candidates) {
          if (score < 0.5) continue
          const result = this.runTmcc(mode, gi, planes, m)
          if (result !== null) {
            const spOffset = estimateSpPhase(planes, mode, m)
            this.applyLock(mode, gi, m, fFrac, n, spOffset, result.info, result.frameStart)
            return true
          }
        }
      } finally {
        sync.dispose()
      }
    }
    if (this.bufLen > ACQUIRE_MIN_SAMPLES) {
      const drop = this.bufLen - ACQUIRE_MIN_SAMPLES
      this.bufRe.copyWithin(0, drop, this.bufLen)
      this.bufIm.copyWithin(0, drop, this.bufLen)
      this.bufLen -= drop
      this.lastAcquireLen = this.bufLen
    }
    return false
  }

  private extractFullPlanes(
    cRe: Float32Array,
    cIm: Float32Array,
    starts: readonly number[],
    n: number,
  ): ComplexBins[] {
    const planes: ComplexBins[] = []
    const half = n >> 1
    const cap = Math.min(starts.length, ACQUIRE_MAX_SYMBOLS)
    const rels = new Int32Array(cap)
    let count = 0
    for (let s = 0; s < cap; s++) {
      const start = starts[s]
      if (start + n > cRe.length) break
      rels[count++] = start
    }
    if (count === 0) return planes

    const bins = count * n
    if (this.acqBatchRe.length < bins) {
      this.acqBatchRe = new Float32Array(bins)
      this.acqBatchIm = new Float32Array(bins)
    }
    const fRe = this.acqBatchRe.subarray(0, bins)
    const fIm = this.acqBatchIm.subarray(0, bins)
    this.fft.forwardBatchFrom(cRe, cIm, rels.subarray(0, count), n, fRe, fIm)

    for (let s = 0; s < count; s++) {
      let plane = this.planePool[s]
      if (plane === undefined || plane.re.length !== n) {
        plane = { re: new Float32Array(n), im: new Float32Array(n) }
        this.planePool[s] = plane
      }
      const re = plane.re
      const im = plane.im
      const base = s * n
      // fftshift by `half` as two block copies instead of an elementwise rotate.
      re.set(fRe.subarray(base, base + half), half)
      re.set(fRe.subarray(base + half, base + n), 0)
      im.set(fIm.subarray(base, base + half), half)
      im.set(fIm.subarray(base + half, base + n), 0)
      planes.push({ re, im })
    }
    return planes
  }

  private runTmcc(
    mode: TransmissionMode,
    gi: number,
    planes: readonly ComplexBins[],
    m: number,
  ): { info: TmccInfo; frameStart: number } | null {
    const half = MODE_PARAMS[mode].oneSegFftSize >> 1
    const tmcc = tmccCarriersFor(mode)
    const dec = new WasmTmccDecoder(mode, gi)
    const tr = new Float32Array(tmcc.length)
    const ti = new Float32Array(tmcc.length)
    let info = dec.push(tr, ti)
    for (let s = 1; s < planes.length; s++) {
      const angle = (-2 * Math.PI * (m + MODE_PARAMS[mode].carriersPerSegment / 2) * s) / gi
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      for (let c = 0; c < tmcc.length; c++) {
        const bin = half + m + tmcc[c]
        if (bin < 0 || bin >= planes[s].re.length) {
          tr[c] = 0
          ti[c] = 0
          continue
        }
        tr[c] = planes[s].re[bin] * cos - planes[s].im[bin] * sin
        ti[c] = planes[s].re[bin] * sin + planes[s].im[bin] * cos
      }
      info = dec.push(tr, ti)
    }
    const layer = info.layers.A
    const frameStart = dec.frameStartSymbol
    dec.dispose()
    if (
      !info.locked ||
      !info.partialReception ||
      !layer ||
      layer.segments !== 1 ||
      layer.modulation > 3 ||
      layer.codeRate > 4 ||
      layer.timeInterleave > 3
    )
      return null
    return { info, frameStart: Math.max(0, frameStart - 1) }
  }

  private applyLock(
    mode: TransmissionMode,
    gi: number,
    m: number,
    fFrac: number,
    n: number,
    spOffset: number,
    info: TmccInfo,
    frameStart: number,
  ): void {
    this.mode = mode
    this.gi = gi
    this.integerCarrierOffset = m
    this.fractionalOffsetHz = fFrac
    this.tmccInfo = info
    this.oneSeg = info.layers.A !== null ? new OneSegDecoder(info) : null
    this.frontend = new WasmFrontend({
      mode,
      fftSize: n,
      gi,
      sampleRate: ONESEG_SAMPLING_HZ,
      carrierBase: m,
      fractionalOffsetHz: fFrac,
      spOffset,
      frameStartSymbol: frameStart,
      carriersPerSegment: MODE_PARAMS[mode].carriersPerSegment,
      dataCount: MODE_PARAMS[mode].dataCarriersPerSegment,
      segRef: segPilotReference(mode),
      dataIndices: [0, 1, 2, 3].map((phase) => dataCarriersFor(mode, phase)),
      tmccCarriers: tmccCarriersFor(mode),
    })
    this.frontendSymbolBase = this.symbolsProcessed
    this.lastProgressAt = this.clock()
    this.lastProgressTsBytes = this.tsBytes
    this.callbacks.onTmcc?.(info)
    this.setState('locked')
    // Feed samples buffered during acquisition (not yet derotated).
    this.processLocked(this.bufRe.subarray(0, this.bufLen), this.bufIm.subarray(0, this.bufLen))
    this.bufLen = 0
  }

  private processLocked(re: Float32Array, im: Float32Array): void {
    const frontend = this.frontend
    if (!frontend) return
    frontend.push(re, im)
    this.applyFrontendStats()
    this.drainFrontend()
  }

  /** Pull sync quality, MER and TMCC updates out of the fused front end. */
  private applyFrontendStats(): void {
    const frontend = this.frontend
    if (!frontend) return
    const stats = frontend.stats()
    this.lastGammaMag = stats.gammaMagnitude
    this.lastPhi = stats.phi
    this.lastSignalPower = stats.signalPower
    this.lastMerDb = stats.merDb
    this.symbolsProcessed = this.frontendSymbolBase + stats.symbolsProcessed
    const info = frontend.tmccInfo()
    if (info !== this.tmccInfo) {
      this.tmccInfo = info
      this.callbacks.onTmcc?.(info)
    }
  }

  /** Decode the equalized planes the front end accumulated into MPEG-TS. */
  private drainFrontend(): void {
    const frontend = this.frontend
    if (!frontend) return
    const count = frontend.pendingCount()
    if (count === 0) return
    if (this.oneSeg === null) {
      frontend.clearPending()
      return
    }
    this.oneSeg.prepareDecode(count)
    const out = this.oneSeg.decodeContiguous(frontend.pendingRe(), frontend.pendingIm(), count)
    frontend.clearPending()
    if (out.length > 0) {
      this.tsBytes += out.length
      this.callbacks.onTs?.(out)
    }
  }

  private append(re: Float32Array, im: Float32Array): void {
    const need = this.bufLen + re.length
    if (need > this.bufRe.length) {
      let cap = this.bufRe.length || 1024
      while (cap < need) cap <<= 1
      const nr = new Float32Array(cap)
      nr.set(this.bufRe.subarray(0, this.bufLen))
      const ni = new Float32Array(cap)
      ni.set(this.bufIm.subarray(0, this.bufLen))
      this.bufRe = nr
      this.bufIm = ni
    }
    this.bufRe.set(re, this.bufLen)
    this.bufIm.set(im, this.bufLen)
    this.bufLen += re.length
  }

  private setState(state: PipelineState): void {
    if (this.state === state) return
    this.state = state
    this.callbacks.onState?.(state)
  }

  private emitStats(): void {
    const gamma = this.lastGammaMag
    const phi = this.lastPhi
    const cnDb = phi > gamma && gamma > 0 ? 10 * Math.log10(gamma / (phi - gamma)) : null
    const carrierSpacing = this.mode !== null ? MODE_PARAMS[this.mode].carrierSpacingHz : 0
    const frequencyOffsetHz =
      this.fractionalOffsetHz !== null
        ? this.fractionalOffsetHz + this.integerCarrierOffset * carrierSpacing
        : null
    const quality: ReceptionQuality = {
      signalLevelDb: this.lastSignalPower > 0 ? 10 * Math.log10(this.lastSignalPower) : null,
      cnDb,
      merDb: this.lastMerDb,
      ber: null,
      packetErrors: this.oneSeg?.tsStats.syncErrors ?? 0,
      frequencyOffsetHz,
    }
    this.callbacks.onStats?.({
      state: this.state,
      quality,
      mode: this.mode,
      guardIntervalRatio: this.gi,
      carrierOffset: this.mode !== null ? this.integerCarrierOffset : null,
      symbolsProcessed: this.symbolsProcessed,
      tsBytes: this.tsBytes,
      bufferedSamples: this.bufLen,
    })
  }
}
