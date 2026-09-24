import { describe, expect, it } from 'vitest'
import {
  MODE_PARAMS,
  ONESEG_SAMPLING_HZ,
  pilotReference,
  oneSegTmccCarriers,
  scatteredPilotIndices,
  NUM_SEGMENTS,
} from './isdbtParams'

describe('mode parameters', () => {
  it('defines the three ISDB-T modes consistently', () => {
    expect(MODE_PARAMS[1].fftSize).toBe(2048)
    expect(MODE_PARAMS[2].fftSize).toBe(4096)
    expect(MODE_PARAMS[3].fftSize).toBe(8192)
    for (const mode of [1, 2, 3] as const) {
      const p = MODE_PARAMS[mode]
      expect(p.oneSegFftSize * 8).toBe(p.fftSize)
      expect(p.dataCarriersPerSegment + p.spPerSegment + p.tmccPerSegment + p.acPerSegment).toBe(
        p.carriersPerSegment,
      )
    }
  })

  it('uses 64/63 MHz for one-seg', () => {
    expect(ONESEG_SAMPLING_HZ).toBeCloseTo(1_015_873.0158, 3)
  })

  it('has 13 segments', () => {
    expect(NUM_SEGMENTS).toBe(13)
  })
})

describe('TMCC carriers', () => {
  it('exposes 1/2/4 TMCC carriers for the center segment per mode', () => {
    expect(oneSegTmccCarriers(1)).toHaveLength(1)
    expect(oneSegTmccCarriers(2)).toHaveLength(2)
    expect(oneSegTmccCarriers(3)).toHaveLength(4)
  })

  it('places mode-3 one-seg TMCC carriers inside the center segment', () => {
    for (const c of oneSegTmccCarriers(3)) {
      expect(c).toBeGreaterThanOrEqual(0)
      expect(c).toBeLessThan(MODE_PARAMS[3].carriersPerSegment)
    }
  })
})

describe('scattered pilots', () => {
  it('staggers by 3 carriers every symbol', () => {
    expect(scatteredPilotIndices(0, 432)).toContain(0)
    expect(scatteredPilotIndices(1, 432)).toContain(3)
    expect(scatteredPilotIndices(2, 432)).toContain(6)
    expect(scatteredPilotIndices(3, 432)).toContain(9)
    expect(scatteredPilotIndices(4, 432)[0]).toBe(0)
  })
})

describe('pilot reference', () => {
  it('produces +/- 4/3 values', () => {
    const ref = pilotReference(32)
    for (const v of ref) {
      expect(Math.abs(v)).toBeCloseTo(4 / 3, 6)
    }
  })

  it('is deterministic', () => {
    expect(Array.from(pilotReference(16))).toEqual(Array.from(pilotReference(16)))
  })
})
