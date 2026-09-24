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
import { u8ToComplex } from './carrier'
import type { ComplexPlane } from './stages/carrierDemod'
import { pilotReferenceAt, type ComplexBins } from './stages/channelEstimation'
import { TmccDecoder } from './stages/tmcc'
import { OneSegDecoder } from './oneSegDecoder'
import { WasmFftBackend } from './wasm/fft'
import { WasmChannelEstimator, equalizeWasm } from './wasm/demap'
import { WasmOfdmSynchronizer } from './wasm/ofdm'
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
}

const ACQUIRE_MIN_SAMPLES = 750_000
const ACQUIRE_MAX_SYMBOLS = 900
const TMCC_CFO_RANGE = 320
const TS_BATCH_SYMBOLS = 32

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
  for (const c of oneSegTmccCarriers(mode)) exclude.add(c)
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

/** CFO-invariant BPSK concentration of the TMCC carriers at integer shift `m`. */
function bpskMetric(
  planes: readonly ComplexBins[],
  half: number,
  tmcc: readonly number[],
  m: number,
): number {
  let sr = 0
  let si = 0
  let count = 0
  const n = planes[0].re.length
  for (let s = 1; s < planes.length; s++) {
    for (const k of tmcc) {
      const c = half + m + k
      if (c < 0 || c >= n) continue
      const dr = planes[s].re[c] * planes[s - 1].re[c] + planes[s].im[c] * planes[s - 1].im[c]
      const di = planes[s].im[c] * planes[s - 1].re[c] - planes[s].re[c] * planes[s - 1].im[c]
      const mag = Math.hypot(dr, di)
      if (mag < 1e-9) continue
      const cosd = dr / mag
      const sind = di / mag
      sr += cosd * cosd - sind * sind
      si += 2 * cosd * sind
      count++
    }
  }
  return count > 0 ? Math.hypot(sr, si) / count : 0
}

function estimateIntegerCfo(
  planes: readonly ComplexBins[],
  mode: TransmissionMode,
): { m: number; score: number }[] {
  const half = MODE_PARAMS[mode].oneSegFftSize >> 1
  const tmcc = oneSegTmccCarriers(mode)
  const scored: { m: number; score: number }[] = []
  for (let m = -TMCC_CFO_RANGE; m <= TMCC_CFO_RANGE; m++) {
    scored.push({ m, score: bpskMetric(planes, half, tmcc, m) })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, 4)
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
  let best = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let offset = 0; offset < 4; offset++) {
    let variation = 0
    let power = 0
    for (let s = 0; s < planes.length; s++) {
      const sp = scatteredPilotIndices((s + offset) % 4, cps)
      let prevRe = 0
      let prevIm = 0
      let havePrev = false
      for (const c of sp) {
        const bin = half + m + c
        if (bin < 0 || bin >= n) continue
        const p = pilotReferenceAt(c, mode)
        const hr = planes[s].re[bin] / p
        const hi = planes[s].im[bin] / p
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

function selectCarriers(src: ComplexBins, indices: readonly number[]): ComplexPlane {
  const re = new Float32Array(indices.length)
  const im = new Float32Array(indices.length)
  for (let i = 0; i < indices.length; i++) {
    re[i] = src.re[indices[i]]
    im[i] = src.im[indices[i]]
  }
  return { re, im }
}

export class OneSegPipeline {
  private readonly callbacks: OneSegPipelineCallbacks
  private readonly options: Required<OneSegPipelineOptions>
  private readonly dc = new WasmDcRemoval(0.001)
  private resampler: WasmFractionalResampler
  private readonly fft = new WasmFftBackend()

  private state: PipelineState = 'idle'
  private bufRe = new Float32Array(1 << 20)
  private bufIm = new Float32Array(1 << 20)
  private bufLen = 0
  private bufferStart = 0
  private derotatedUpTo = 0
  private syncFed = 0
  private lastAcquireLen = 0

  private mode: TransmissionMode | null = null
  private gi: number | null = null
  private fftSize = 0
  private carrierBase = 0
  private spOffset = 0
  private frameStartSymbol = 0
  private integerCarrierOffset = 0
  private fractionalOffsetHz: number | null = null

  private nco: WasmNcoCorrector | null = null
  private sync: WasmOfdmSynchronizer | null = null
  private channel: WasmChannelEstimator | null = null
  private tmcc: TmccDecoder | null = null
  private oneSeg: OneSegDecoder | null = null
  private tmccInfo: TmccInfo | null = null
  private pendingPlanes: ComplexPlane[] = []
  private symbolIndex = 0
  private symbolsProcessed = 0
  private tsBytes = 0
  private lastGammaMag = 0
  private lastPhi = 0
  private lastSignalPower = 0
  private lastMerDb: number | null = null

  constructor(callbacks: OneSegPipelineCallbacks = {}, options: OneSegPipelineOptions = {}) {
    this.callbacks = callbacks
    this.options = {
      sourceSampleRate: options.sourceSampleRate ?? 1_200_000,
      cutoffHz: options.cutoffHz ?? 450_000,
    }
    this.resampler = new WasmFractionalResampler(
      this.options.sourceSampleRate,
      ONESEG_SAMPLING_HZ,
      this.options.cutoffHz,
    )
  }

  /** Feed one raw IQ chunk (U8/I8 interleaved, or F32 complex interleaved). */
  pushIq(chunk: IqChunk): void {
    const count = Math.floor(chunk.data.length / 2)
    const re = new Float32Array(count)
    const im = new Float32Array(count)
    const data = chunk.data
    if (chunk.format === 'u8') {
      const norm = u8ToComplex(
        data instanceof Uint8Array ? data : Uint8Array.from(data as ArrayLike<number>),
      )
      for (let i = 0; i < count; i++) {
        re[i] = norm[2 * i]
        im[i] = norm[2 * i + 1]
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
    this.append(rs.re, rs.im)
    if (this.state === 'idle') this.setState('acquiring')

    if (this.state === 'locked') {
      this.processLocked()
    } else if (
      this.bufLen >= ACQUIRE_MIN_SAMPLES &&
      this.bufLen >= this.lastAcquireLen + ACQUIRE_MIN_SAMPLES
    ) {
      this.lastAcquireLen = this.bufLen
      this.tryAcquire()
    }
    this.emitStats()
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
      this.processLocked()
      this.flushTs()
    }
    this.emitStats()
  }

  /** Drop buffered samples and reset all DSP state. */
  discardBuffer(): void {
    this.bufLen = 0
    this.bufferStart = 0
    this.derotatedUpTo = 0
    this.syncFed = 0
    this.lastAcquireLen = 0
    this.dc.reset()
    this.resampler.reset()
    this.nco?.dispose()
    this.sync?.dispose()
    this.channel?.dispose()
    this.oneSeg?.dispose()
    this.nco = null
    this.sync = null
    this.channel = null
    this.tmcc = null
    this.oneSeg = null
    this.tmccInfo = null
    this.pendingPlanes = []
    this.mode = null
    this.gi = null
    this.integerCarrierOffset = 0
    this.fractionalOffsetHz = null
    this.frameStartSymbol = 0
    this.symbolIndex = 0
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

        const cRe = this.bufRe.slice(0, this.bufLen)
        const cIm = this.bufIm.slice(0, this.bufLen)
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
            this.processLocked()
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
    const fRe = new Float32Array(n)
    const fIm = new Float32Array(n)
    for (let s = 0; s < cap; s++) {
      const start = starts[s]
      if (start + n > cRe.length) break
      fRe.set(cRe.subarray(start, start + n))
      fIm.set(cIm.subarray(start, start + n))
      this.fft.forward(fRe, fIm)
      const re = new Float32Array(n)
      const im = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const j = (i + half) % n
        re[j] = fRe[i]
        im[j] = fIm[i]
      }
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
    const tmcc = oneSegTmccCarriers(mode)
    const dec = new TmccDecoder(mode, gi)
    let info = dec.push(new Float32Array(tmcc.length), new Float32Array(tmcc.length))
    for (let s = 1; s < planes.length; s++) {
      const tr = new Float32Array(tmcc.length)
      const ti = new Float32Array(tmcc.length)
      const angle = (-2 * Math.PI * (m + MODE_PARAMS[mode].carriersPerSegment / 2) * s) / gi
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      for (let c = 0; c < tmcc.length; c++) {
        const bin = half + m + tmcc[c]
        if (bin < 0 || bin >= planes[s].re.length) continue
        tr[c] = planes[s].re[bin] * cos - planes[s].im[bin] * sin
        ti[c] = planes[s].re[bin] * sin + planes[s].im[bin] * cos
      }
      info = dec.push(tr, ti)
    }
    const layer = info.layers.A
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
    return { info, frameStart: Math.max(0, dec.frameStartSymbol - 1) }
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
    this.fftSize = n
    this.integerCarrierOffset = m
    this.carrierBase = m
    this.spOffset = spOffset
    this.frameStartSymbol = frameStart
    this.fractionalOffsetHz = fFrac
    this.nco = new WasmNcoCorrector(fFrac, ONESEG_SAMPLING_HZ)
    this.sync = new WasmOfdmSynchronizer(n, gi, ONESEG_SAMPLING_HZ, true)
    this.channel = new WasmChannelEstimator(mode, 1)
    this.tmcc = new TmccDecoder(mode, gi)
    this.oneSeg = info.layers.A !== null ? new OneSegDecoder(info) : null
    this.tmccInfo = info
    this.pendingPlanes = []
    this.symbolIndex = 0
    this.derotatedUpTo = 0
    this.syncFed = 0
    this.callbacks.onTmcc?.(info)
    this.setState('locked')
  }

  private processLocked(): void {
    const nco = this.nco
    const sync = this.sync
    if (!nco || !sync) return
    if (this.derotatedUpTo < this.bufLen) {
      nco.process(
        this.bufRe.subarray(this.derotatedUpTo, this.bufLen),
        this.bufIm.subarray(this.derotatedUpTo, this.bufLen),
      )
      this.derotatedUpTo = this.bufLen
    }
    if (this.syncFed < this.bufLen) {
      const res = sync.process(
        this.bufRe.subarray(this.syncFed, this.bufLen),
        this.bufIm.subarray(this.syncFed, this.bufLen),
      )
      this.syncFed = this.bufLen
      this.lastGammaMag = res.gammaMagnitude
      this.lastPhi = res.phi
      for (const start of res.symbolStarts) this.processSymbol(start)
      const drop = Math.max(0, this.bufLen - 2 * this.fftSize)
      this.bufRe.copyWithin(0, drop, this.bufLen)
      this.bufIm.copyWithin(0, drop, this.bufLen)
      this.bufLen -= drop
      this.bufferStart += drop
      this.derotatedUpTo -= drop
      this.syncFed -= drop
    }
  }

  private processSymbol(start: number): void {
    start -= this.bufferStart
    const mode = this.mode
    const n = this.fftSize
    if (mode === null || start + n > this.bufLen) return
    const fRe = new Float32Array(n)
    const fIm = new Float32Array(n)
    fRe.set(this.bufRe.subarray(start, start + n))
    fIm.set(this.bufIm.subarray(start, start + n))
    this.fft.forward(fRe, fIm)
    const carriers = this.extractAtBase(fRe, fIm, n, mode)
    this.symbolsProcessed++

    const tmccC = oneSegTmccCarriers(mode)
    const tr = new Float32Array(tmccC.length)
    const ti = new Float32Array(tmccC.length)
    // Integer CFO rotates successive symbols by 2π * offset * GI / FFT size.
    const angle =
      (-2 *
        Math.PI *
        (this.carrierBase + MODE_PARAMS[mode].carriersPerSegment / 2) *
        this.symbolIndex) /
      this.gi!
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    for (let c = 0; c < tmccC.length; c++) {
      tr[c] = carriers.re[tmccC[c]] * cos - carriers.im[tmccC[c]] * sin
      ti[c] = carriers.re[tmccC[c]] * sin + carriers.im[tmccC[c]] * cos
    }
    const info = this.tmcc?.push(tr, ti) ?? null
    if (info !== null && info !== this.tmccInfo) {
      this.tmccInfo = info
      this.callbacks.onTmcc?.(info)
    }

    if (this.oneSeg !== null && this.symbolIndex >= this.frameStartSymbol) {
      const spPhase = (this.symbolIndex + this.spOffset) % 4
      const h = this.channel!.estimate(carriers, spPhase)
      const z = equalizeWasm(carriers, h)
      this.updateMer(z, mode, spPhase)
      const plane = selectCarriers(z, dataCarriersFor(mode, spPhase))
      this.pendingPlanes.push(plane)
      if (this.pendingPlanes.length >= TS_BATCH_SYMBOLS) this.flushTs()
    }
    this.symbolIndex++
  }

  private extractAtBase(
    fRe: Float32Array,
    fIm: Float32Array,
    n: number,
    mode: TransmissionMode,
  ): ComplexBins {
    const cps = MODE_PARAMS[mode].carriersPerSegment
    const re = new Float32Array(cps)
    const im = new Float32Array(cps)
    for (let c = 0; c < cps; c++) {
      const bin = (this.carrierBase + c + n) % n
      re[c] = fRe[bin]
      im[c] = fIm[bin]
    }
    return { re, im }
  }

  private updateMer(z: ComplexBins, mode: TransmissionMode, sif: number): void {
    const indices = dataCarriersFor(mode, sif)
    let power = 0
    for (const c of indices) power += z.re[c] * z.re[c] + z.im[c] * z.im[c]
    power /= indices.length
    this.lastSignalPower = power
    const scale = Math.sqrt(power / 2)
    let err = 0
    for (const c of indices) {
      const idealRe = z.re[c] >= 0 ? scale : -scale
      const idealIm = z.im[c] >= 0 ? scale : -scale
      const dr = z.re[c] - idealRe
      const di = z.im[c] - idealIm
      err += dr * dr + di * di
    }
    err /= indices.length
    this.lastMerDb = power > 0 && err > 0 ? 10 * Math.log10(power / err) : null
  }

  private flushTs(): void {
    if (this.oneSeg === null || this.pendingPlanes.length === 0) return
    const out = this.oneSeg.decode(this.pendingPlanes)
    this.pendingPlanes = []
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
