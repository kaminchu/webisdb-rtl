/**
 * Carrier frequency offset estimation (guard-interval correlation) and
 * correction (numerically controlled oscillator).
 *
 * gamma[n] = sum_{i=0}^{L-1} r[n+i] * conj(r[n+i+N])
 * Phi[n]   = 0.5 * sum_{i=0}^{L-1} (|r[n+i]|^2 + |r[n+i+N]|^2)
 * Lambda[n] = |gamma[n]| - rho * Phi[n],  rho = 0.5
 *
 * Timing is argmax Lambda. For a positive offset f (received as e^{j2*pi*f*n/fs})
 * the guard-interval correlation rotates by exp(-j2*pi*f*N/fs), so the fractional
 * offset recovered from arg(gamma) is f = -arg(gamma) * fs / (2*pi*N).
 */

export interface FrequencyOffsetEstimate {
  /** Sample index (relative to the supplied block) of the correlation peak. */
  timingIndex: number
  /** Fractional carrier offset in Hz, within +/- fs/(2N). */
  fractionalOffsetHz: number
  /** Peak correlation metric |gamma| - rho*Phi. */
  metric: number
}

const RHO = 0.5

export class FrequencyOffsetEstimator {
  private readonly fftSize: number
  private readonly giRatio: number
  private readonly sampleRateHz: number

  constructor(fftSize: number, giRatio: number, sampleRateHz: number) {
    this.fftSize = fftSize
    this.giRatio = giRatio
    this.sampleRateHz = sampleRateHz
  }

  estimate(
    re: Float32Array,
    im: Float32Array,
    maxSearch = Number.POSITIVE_INFINITY,
  ): FrequencyOffsetEstimate {
    const n = this.fftSize
    const l = Math.floor(n / this.giRatio)
    const limit = Math.min(re.length - (n + l), maxSearch)
    let bestMetric = Number.NEGATIVE_INFINITY
    let bestIndex = -1
    let bestGammaRe = 0
    let bestGammaIm = 0

    for (let start = 0; start <= limit; start++) {
      let gammaRe = 0
      let gammaIm = 0
      let phi = 0
      for (let i = 0; i < l; i++) {
        const a = start + i
        const b = a + n
        gammaRe += re[a] * re[b] + im[a] * im[b]
        gammaIm += im[a] * re[b] - re[a] * im[b]
        phi += 0.5 * (re[a] * re[a] + im[a] * im[a] + re[b] * re[b] + im[b] * im[b])
      }
      const mag = Math.hypot(gammaRe, gammaIm)
      const metric = mag - RHO * phi
      if (metric > bestMetric) {
        bestMetric = metric
        bestIndex = start
        bestGammaRe = gammaRe
        bestGammaIm = gammaIm
      }
    }

    if (bestIndex < 0) {
      return { timingIndex: -1, fractionalOffsetHz: 0, metric: 0 }
    }
    const phase = Math.atan2(bestGammaIm, bestGammaRe)
    const fractionalOffsetHz = (-phase * this.sampleRateHz) / (2 * Math.PI * n)
    return { timingIndex: bestIndex, fractionalOffsetHz, metric: bestMetric }
  }
}

/** Derotate complex samples by a constant frequency offset. */
export class NcoCorrector {
  private offsetHz: number
  private readonly sampleRateHz: number
  private phase = 0

  constructor(offsetHz: number, sampleRateHz: number) {
    this.offsetHz = offsetHz
    this.sampleRateHz = sampleRateHz
  }

  setOffset(offsetHz: number): void {
    this.offsetHz = offsetHz
  }

  reset(): void {
    this.phase = 0
  }

  process(re: Float32Array, im: Float32Array): void {
    const step = (-2 * Math.PI * this.offsetHz) / this.sampleRateHz
    let phase = this.phase
    for (let i = 0; i < re.length; i++) {
      const c = Math.cos(phase)
      const s = Math.sin(phase)
      const r = re[i] * c - im[i] * s
      const q = re[i] * s + im[i] * c
      re[i] = r
      im[i] = q
      phase += step
      if (phase > Math.PI) phase -= 2 * Math.PI
      else if (phase < -Math.PI) phase += 2 * Math.PI
    }
    this.phase = phase
  }
}
