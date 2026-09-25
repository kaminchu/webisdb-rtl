/** PES timestamps are expressed in 90 kHz units. */
export const PTS_HZ = 90_000

export const DEFAULT_TOLERANCE_SEC = 0
export const DEFAULT_MAX_LATE_SEC = 0.5

export function pts90kToSeconds(pts: number): number {
  return pts / PTS_HZ
}

export function pts90kToMicros(pts: number): number {
  return Math.round((pts / PTS_HZ) * 1_000_000)
}

export function microsToPts90k(micros: number): number {
  return Math.round((micros / 1_000_000) * PTS_HZ)
}

/** Verdict for a video frame against the master clock. */
export const SyncDecision = {
  Render: 'render',
  Hold: 'hold',
  Drop: 'drop',
} as const

export type SyncDecision = (typeof SyncDecision)[keyof typeof SyncDecision]

export interface AvSyncOptions {
  /** Wall clock in seconds; defaults to `performance.now() / 1000`. */
  wallClock?: () => number
  /** Audio media time (PTS seconds), or null while audio is unavailable. */
  audioClock?: () => number | null
  /** Render window around the master clock, in seconds. */
  toleranceSec?: number
  /** Frames later than this are dropped rather than rendered late. */
  maxLateSec?: number
}

/**
 * Maps a 90 kHz PES timeline onto the master clock. The master clock follows
 * the audio clock whenever audio is playing (so A/V stay locked), otherwise it
 * follows the wall clock anchored at the first PTS.
 */
export class AvSync {
  private readonly wallClock: () => number
  private readonly audioClock: (() => number | null) | null
  private readonly toleranceSec: number
  private readonly maxLateSec: number
  private wallOffsetSec: number | null = null
  private anchorPtsValue: number | null = null

  constructor(options: AvSyncOptions = {}) {
    this.wallClock = options.wallClock ?? (() => performance.now() / 1000)
    this.audioClock = options.audioClock ?? null
    this.toleranceSec = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC
    this.maxLateSec = options.maxLateSec ?? DEFAULT_MAX_LATE_SEC
  }

  get anchored(): boolean {
    return this.wallOffsetSec !== null
  }

  get usesAudioClock(): boolean {
    return (this.audioClock?.() ?? null) !== null
  }

  get anchoredPtsSec(): number | null {
    return this.anchorPtsValue
  }

  /** Bind the wall clock to a PTS, allowing time to buffer before presentation. */
  anchor(pts90k: number, delaySec = 0): void {
    const ptsSec = pts90kToSeconds(pts90k)
    const wall = this.wallClock()
    this.wallOffsetSec = wall - ptsSec + delaySec
    this.anchorPtsValue = ptsSec
  }

  /** Current media time in seconds. */
  now(): number {
    const audio = this.audioClock?.() ?? null
    const wall = this.wallClock()
    if (audio !== null) {
      this.wallOffsetSec = wall - audio
      return audio
    }
    return this.wallOffsetSec !== null ? wall - this.wallOffsetSec : wall
  }

  /** Classify a frame PTS against the master clock. */
  decision(pts90k: number): SyncDecision {
    if (!this.anchored) return SyncDecision.Render
    const delta = pts90kToSeconds(pts90k) - this.now()
    if (delta > this.toleranceSec) return SyncDecision.Hold
    if (delta < -this.maxLateSec) return SyncDecision.Drop
    return SyncDecision.Render
  }

  reset(): void {
    this.wallOffsetSec = null
    this.anchorPtsValue = null
  }
}

export interface DriftEstimate {
  /** Slope of measured vs reference; 1 means no drift. */
  slope: number
  intercept: number
  /** Slope minus 1; positive when the measured clock runs fast. */
  drift: number
  samples: number
}

/**
 * Least-squares estimator for clock drift. Feed `(reference, measured)` pairs
 * (e.g. wall-clock seconds and audio-clock seconds) and read `estimate()`.
 */
export class DriftEstimator {
  private readonly capacity: number
  private readonly xs: number[] = []
  private readonly ys: number[] = []

  constructor(capacity = 64) {
    this.capacity = Math.max(2, capacity)
  }

  get count(): number {
    return this.xs.length
  }

  add(referenceSec: number, measuredSec: number): void {
    this.xs.push(referenceSec)
    this.ys.push(measuredSec)
    if (this.xs.length > this.capacity) {
      this.xs.shift()
      this.ys.shift()
    }
  }

  estimate(): DriftEstimate | null {
    const n = this.xs.length
    if (n < 2) return null
    let sumX = 0
    let sumY = 0
    let sumXX = 0
    let sumXY = 0
    for (let i = 0; i < n; i++) {
      const x = this.xs[i]
      const y = this.ys[i]
      sumX += x
      sumY += y
      sumXX += x * x
      sumXY += x * y
    }
    const denominator = n * sumXX - sumX * sumX
    if (denominator === 0) return null
    const slope = (n * sumXY - sumX * sumY) / denominator
    const intercept = (sumY - slope * sumX) / n
    return { slope, intercept, drift: slope - 1, samples: n }
  }

  reset(): void {
    this.xs.length = 0
    this.ys.length = 0
  }
}
