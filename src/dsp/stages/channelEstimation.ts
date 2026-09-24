/**
 * Channel estimation from scattered pilots and equalization.
 *
 * LS estimates H = Y / P are taken at the scattered-pilot carriers, then linearly
 * interpolated across frequency (12-carrier pilot spacing with the 3-carrier
 * per-symbol stagger) and optionally smoothed across time by `ChannelEstimator`.
 *
 * NOTE: the pilot reference is indexed by the center-segment carrier's position in
 * the full active-carrier space (pilotReference advances per active carrier). Only
 * scattered pilots are used; the per-segment continual pilot is not modelled yet.
 */

import {
  MODE_PARAMS,
  centerSegmentCarrierOffset,
  pilotReference,
  scatteredPilotIndices,
  type TransmissionMode,
} from '../isdbtParams'

export interface ComplexBins {
  re: Float32Array
  im: Float32Array
}

export interface ChannelEstimate {
  re: Float32Array
  im: Float32Array
}

const pilotRefCache = new Map<number, Float32Array>()

function activePilotReference(mode: TransmissionMode): Float32Array {
  let ref = pilotRefCache.get(mode)
  if (!ref) {
    ref = pilotReference(MODE_PARAMS[mode].activeCarriers)
    pilotRefCache.set(mode, ref)
  }
  return ref
}

/** Scattered-pilot reference value (+/- 4/3) for a center-segment carrier. */
export function pilotReferenceAt(carrier: number, mode: TransmissionMode): number {
  const idx = centerSegmentCarrierOffset(mode) + carrier
  return activePilotReference(mode)[idx]
}

export function estimateChannel(
  bins: ComplexBins,
  symbolIndexInFrame: number,
  mode: TransmissionMode,
): ChannelEstimate {
  const cps = MODE_PARAMS[mode].carriersPerSegment
  const hRe = new Float32Array(cps)
  const hIm = new Float32Array(cps)
  const pilots = scatteredPilotIndices(symbolIndexInFrame, cps)

  for (const k of pilots) {
    const p = pilotReferenceAt(k, mode)
    const inv = 1 / p
    hRe[k] = bins.re[k] * inv
    hIm[k] = bins.im[k] * inv
  }

  for (let i = 0; i + 1 < pilots.length; i++) {
    const a = pilots[i]
    const b = pilots[i + 1]
    const span = b - a
    const dRe = hRe[b] - hRe[a]
    const dIm = hIm[b] - hIm[a]
    for (let c = a + 1; c < b; c++) {
      const t = (c - a) / span
      hRe[c] = hRe[a] + dRe * t
      hIm[c] = hIm[a] + dIm * t
    }
  }

  const first = pilots[0]
  for (let c = 0; c < first; c++) {
    hRe[c] = hRe[first]
    hIm[c] = hIm[first]
  }
  const last = pilots[pilots.length - 1]
  for (let c = last + 1; c < cps; c++) {
    hRe[c] = hRe[last]
    hIm[c] = hIm[last]
  }

  return { re: hRe, im: hIm }
}

/** Zero-forcing equalization: Z = Y * conj(H) / |H|^2. */
export function equalize(bins: ComplexBins, h: ChannelEstimate): ComplexBins {
  const n = bins.re.length
  const outRe = new Float32Array(n)
  const outIm = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const hr = h.re[i]
    const hi = h.im[i]
    const d = hr * hr + hi * hi
    const inv = d > 1e-12 ? 1 / d : 0
    outRe[i] = (bins.re[i] * hr + bins.im[i] * hi) * inv
    outIm[i] = (bins.im[i] * hr - bins.re[i] * hi) * inv
  }
  return { re: outRe, im: outIm }
}

/** Stateful estimator with one-pole temporal smoothing between symbols. */
export class ChannelEstimator {
  private readonly mode: TransmissionMode
  private readonly alpha: number
  private prevRe: Float32Array | null = null
  private prevIm: Float32Array | null = null

  constructor(mode: TransmissionMode, alpha = 0.5) {
    this.mode = mode
    this.alpha = alpha
  }

  reset(): void {
    this.prevRe = null
    this.prevIm = null
  }

  estimate(bins: ComplexBins, symbolIndexInFrame: number): ChannelEstimate {
    const cur = estimateChannel(bins, symbolIndexInFrame, this.mode)
    if (this.prevRe && this.prevIm) {
      const a = this.alpha
      const b = 1 - a
      for (let i = 0; i < cur.re.length; i++) {
        cur.re[i] = a * cur.re[i] + b * this.prevRe[i]
        cur.im[i] = a * cur.im[i] + b * this.prevIm[i]
      }
    }
    this.prevRe = cur.re.slice()
    this.prevIm = cur.im.slice()
    return cur
  }
}
