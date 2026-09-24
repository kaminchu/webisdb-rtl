import { describe, expect, it } from 'vitest'
import {
  AvSync,
  DEFAULT_TOLERANCE_SEC,
  DriftEstimator,
  SyncDecision,
  microsToPts90k,
  pts90kToMicros,
  pts90kToSeconds,
} from './avSync'

describe('PTS conversions', () => {
  it('converts 90 kHz units to seconds and microseconds', () => {
    expect(pts90kToSeconds(90_000)).toBe(1)
    expect(pts90kToMicros(90_000)).toBe(1_000_000)
    expect(microsToPts90k(1_000_000)).toBe(90_000)
    expect(microsToPts90k(33_333)).toBe(3_000)
  })
})

describe('AvSync', () => {
  it('renders everything before it is anchored', () => {
    const sync = new AvSync({ wallClock: () => 0 })
    expect(sync.anchored).toBe(false)
    expect(sync.decision(90_000)).toBe(SyncDecision.Render)
  })

  it('anchors the master clock to the wall clock', () => {
    let wall = 100
    const sync = new AvSync({ wallClock: () => wall })
    sync.anchor(90_000 * 10)
    expect(sync.anchored).toBe(true)
    expect(sync.usesAudioClock).toBe(false)
    expect(sync.now()).toBeCloseTo(10)
    wall = 101
    expect(sync.now()).toBeCloseTo(11)
  })

  it('renders, holds and drops around the master clock', () => {
    const wall = 100
    const sync = new AvSync({ wallClock: () => wall })
    sync.anchor(90_000 * 10)
    expect(sync.decision(90_000 * 10)).toBe(SyncDecision.Render)
    expect(sync.decision(90_000 * 10.05)).toBe(SyncDecision.Render)
    expect(sync.decision(90_000 * 11)).toBe(SyncDecision.Hold)
    expect(sync.decision(90_000 * 9.9)).toBe(SyncDecision.Render)
    expect(sync.decision(90_000 * 9)).toBe(SyncDecision.Drop)
  })

  it('follows the audio clock when audio is playing', () => {
    let audio = 5
    let wall = 1000
    const sync = new AvSync({ wallClock: () => wall, audioClock: () => audio })
    sync.anchor(90_000 * 20)
    expect(sync.usesAudioClock).toBe(true)
    expect(sync.now()).toBeCloseTo(20)
    audio = 5.5
    wall = 1000.2
    expect(sync.now()).toBeCloseTo(20.5)
    expect(sync.decision(90_000 * 21)).toBe(SyncDecision.Hold)
    expect(sync.decision(90_000 * 19.9)).toBe(SyncDecision.Drop)
  })

  it('falls back to the wall clock when audio stops', () => {
    let audio: number | null = 5
    let wall = 1000
    const sync = new AvSync({ wallClock: () => wall, audioClock: () => audio })
    sync.anchor(90_000 * 20)
    audio = null
    wall = 1000.25
    expect(sync.usesAudioClock).toBe(false)
    expect(sync.now()).toBeCloseTo(20.25)
  })

  it('honours a custom tolerance', () => {
    const sync = new AvSync({ wallClock: () => 0, toleranceSec: 0.5 })
    sync.anchor(0)
    expect(sync.decision(90_000 * 0.4)).toBe(SyncDecision.Render)
    expect(sync.decision(90_000 * 0.6)).toBe(SyncDecision.Hold)
    expect(DEFAULT_TOLERANCE_SEC).toBeLessThan(0.5)
  })

  it('resets its anchor', () => {
    const sync = new AvSync({ wallClock: () => 0 })
    sync.anchor(90_000)
    sync.reset()
    expect(sync.anchored).toBe(false)
    expect(sync.anchoredPtsSec).toBeNull()
  })
})

describe('DriftEstimator', () => {
  it('returns null with fewer than two samples', () => {
    const estimator = new DriftEstimator()
    expect(estimator.estimate()).toBeNull()
    estimator.add(0, 0)
    expect(estimator.estimate()).toBeNull()
  })

  it('estimates a unit slope for an ideal clock', () => {
    const estimator = new DriftEstimator()
    for (let i = 0; i < 10; i++) estimator.add(i, i)
    const estimate = estimator.estimate()
    expect(estimate?.slope).toBeCloseTo(1, 9)
    expect(estimate?.drift).toBeCloseTo(0, 9)
  })

  it('detects a fast measured clock', () => {
    const estimator = new DriftEstimator()
    for (let i = 0; i < 100; i++) estimator.add(i, i * 1.001 + 0.5)
    const estimate = estimator.estimate()
    expect(estimate?.slope).toBeCloseTo(1.001, 6)
    expect(estimate?.drift).toBeCloseTo(0.001, 6)
    expect(estimate?.intercept).toBeCloseTo(0.5, 6)
  })

  it('bounds its sample window', () => {
    const estimator = new DriftEstimator(4)
    for (let i = 0; i < 10; i++) estimator.add(i, i)
    expect(estimator.count).toBe(4)
    estimator.reset()
    expect(estimator.count).toBe(0)
  })
})
