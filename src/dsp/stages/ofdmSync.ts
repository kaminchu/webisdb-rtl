/**
 * OFDM symbol synchronization from guard-interval correlation.
 *
 * Symbols are located at the maxima of Lambda[n] = |gamma[n]| - rho*Phi[n] (see
 * frequencyCorrection.ts). The returned offsets are the FFT window starts, i.e.
 * the first sample of the useful part (CP start + guard length). The synchronizer
 * keeps an internal sample buffer across calls so it can be driven by arbitrary
 * block sizes. Once locked it advances by exactly one symbol length per symbol;
 * sample-clock drift correction is not implemented yet.
 */

export interface OfdmSyncResult {
  /** Absolute sample indices (stream coordinates) of the FFT window starts. */
  symbolStarts: number[]
  /** Fractional carrier offset in Hz, or null until the first peak is found. */
  fractionalOffsetHz: number | null
  /** Correlation metric at the last tracked symbol. */
  metric: number
  /** |gamma| at the last tracked symbol (coherent signal power). */
  gammaMagnitude: number
  /** Phi at the last tracked symbol (signal + noise power). */
  phi: number
}

const RHO = 0.5

interface Peak {
  index: number
  metric: number
  gammaRe: number
  gammaIm: number
  phi: number
}

export class OfdmSynchronizer {
  private readonly fftSize: number
  private readonly cpLength: number
  private readonly symbolLength: number
  private readonly sampleRateHz: number
  private bufRe: Float32Array
  private bufIm: Float32Array
  private bufLen = 0
  private baseIndex = 0
  private nextStart = -1
  private synced = false
  private lastOffset: number | null = null
  private lastMetric = 0
  private lastGammaMag = 0
  private lastPhi = 0

  constructor(fftSize: number, giRatio: number, sampleRateHz: number) {
    this.fftSize = fftSize
    this.cpLength = Math.floor(fftSize / giRatio)
    this.symbolLength = fftSize + this.cpLength
    this.sampleRateHz = sampleRateHz
    const cap = 4 * this.symbolLength + fftSize
    this.bufRe = new Float32Array(cap)
    this.bufIm = new Float32Array(cap)
  }

  reset(): void {
    this.bufLen = 0
    this.baseIndex = 0
    this.nextStart = -1
    this.synced = false
    this.lastOffset = null
    this.lastMetric = 0
    this.lastGammaMag = 0
    this.lastPhi = 0
  }

  process(re: Float32Array, im: Float32Array): OfdmSyncResult {
    this.append(re, im)
    const starts: number[] = []
    const end = this.baseIndex + this.bufLen

    if (!this.synced) {
      const maxStart = this.bufLen - (this.fftSize + this.cpLength)
      if (maxStart >= 0) {
        const searchTo = Math.min(maxStart, 3 * this.symbolLength)
        const peak = this.findPeak(0, searchTo)
        if (peak && peak.metric > 0) {
          this.synced = true
          this.nextStart = this.baseIndex + peak.index
          this.trackOffset(peak)
        } else {
          const keep = this.symbolLength + this.cpLength
          if (this.bufLen > keep) this.discardFront(this.bufLen - keep)
        }
      }
    }

    if (this.synced) {
      while (this.nextStart + this.symbolLength <= end) {
        starts.push(this.nextStart + this.cpLength)
        const rel = this.nextStart - this.baseIndex
        if (rel + this.fftSize + this.cpLength <= this.bufLen) {
          const peak = this.findPeak(rel, rel)
          if (peak) this.trackOffset(peak)
        }
        this.nextStart += this.symbolLength
      }
      const keepFrom = Math.max(0, this.nextStart - this.baseIndex - this.cpLength)
      if (keepFrom > 0) this.discardFront(keepFrom)
    }

    return {
      symbolStarts: starts,
      fractionalOffsetHz: this.lastOffset,
      metric: this.lastMetric,
      gammaMagnitude: this.lastGammaMag,
      phi: this.lastPhi,
    }
  }

  private findPeak(from: number, to: number): Peak | null {
    const n = this.fftSize
    const l = this.cpLength
    const maxStart = this.bufLen - (n + l)
    const hi = Math.min(to, maxStart)
    let best: Peak | null = null
    for (let start = from; start <= hi; start++) {
      let gammaRe = 0
      let gammaIm = 0
      let phi = 0
      for (let i = 0; i < l; i++) {
        const a = start + i
        const b = a + n
        gammaRe += this.bufRe[a] * this.bufRe[b] + this.bufIm[a] * this.bufIm[b]
        gammaIm += this.bufIm[a] * this.bufRe[b] - this.bufRe[a] * this.bufIm[b]
        phi += 0.5 * (this.bufRe[a] * this.bufRe[a] + this.bufIm[a] * this.bufIm[a])
        phi += 0.5 * (this.bufRe[b] * this.bufRe[b] + this.bufIm[b] * this.bufIm[b])
      }
      const metric = Math.hypot(gammaRe, gammaIm) - RHO * phi
      if (best === null || metric > best.metric) {
        best = { index: start, metric, gammaRe, gammaIm, phi }
      }
    }
    return best
  }

  private trackOffset(peak: Peak): void {
    const phase = Math.atan2(peak.gammaIm, peak.gammaRe)
    this.lastOffset = (-phase * this.sampleRateHz) / (2 * Math.PI * this.fftSize)
    this.lastMetric = peak.metric
    this.lastGammaMag = Math.hypot(peak.gammaRe, peak.gammaIm)
    this.lastPhi = peak.phi
  }

  private ensureCapacity(extra: number): void {
    const need = this.bufLen + extra
    if (need <= this.bufRe.length) return
    let cap = this.bufRe.length || 1024
    while (cap < need) cap <<= 1
    const nr = new Float32Array(cap)
    nr.set(this.bufRe.subarray(0, this.bufLen))
    const ni = new Float32Array(cap)
    ni.set(this.bufIm.subarray(0, this.bufLen))
    this.bufRe = nr
    this.bufIm = ni
  }

  private append(re: Float32Array, im: Float32Array): void {
    this.ensureCapacity(re.length)
    this.bufRe.set(re, this.bufLen)
    this.bufIm.set(im, this.bufLen)
    this.bufLen += re.length
  }

  private discardFront(count: number): void {
    if (count <= 0) return
    this.bufRe.copyWithin(0, count, this.bufLen)
    this.bufIm.copyWithin(0, count, this.bufLen)
    this.bufLen -= count
    this.baseIndex += count
  }
}
