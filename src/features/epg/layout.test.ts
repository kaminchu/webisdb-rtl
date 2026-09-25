import { describe, expect, it } from 'vitest'
import type { Event } from '../../models'
import { buildProgramCell, buildTimeMarks, genreMajor, offsetMinutes } from './layout'

const RANGE_START = new Date('2026-01-01T00:00:00.000Z').getTime()
const PPM = 2

const metrics = {
  rangeStartMs: RANGE_START,
  rangeEndMs: RANGE_START + 2 * 3_600_000,
  pixelsPerMinute: PPM,
  minHeight: 20,
  gap: 2,
}

function makeEvent(overrides: Partial<Event>): Event {
  return {
    eventId: 1,
    serviceId: 1,
    startTime: new Date(RANGE_START),
    duration: 3600,
    title: '番組',
    ...overrides,
  }
}

describe('genreMajor', () => {
  it('extracts the high nibble of the first genre', () => {
    expect(genreMajor([0x74, 0x21])).toBe(7)
  })

  it('returns -1 when there is no genre', () => {
    expect(genreMajor(undefined)).toBe(-1)
    expect(genreMajor([])).toBe(-1)
  })
})

describe('offsetMinutes', () => {
  it('measures minutes from the range start', () => {
    expect(offsetMinutes(RANGE_START + 90 * 60_000, RANGE_START)).toBe(90)
  })
})

describe('buildProgramCell', () => {
  it('positions a program fully inside the window', () => {
    const cell = buildProgramCell(
      makeEvent({ startTime: new Date(RANGE_START + 30 * 60_000), duration: 1800 }),
      metrics,
    )
    expect(cell.top).toBe(60)
    expect(cell.height).toBe((1800 / 60) * PPM - 2)
    expect(cell.clippedStart).toBe(false)
    expect(cell.clippedEnd).toBe(false)
  })

  it('clips a program that starts before the window', () => {
    const cell = buildProgramCell(
      makeEvent({ startTime: new Date(RANGE_START - 30 * 60_000), duration: 3600 }),
      metrics,
    )
    expect(cell.top).toBe(0)
    expect(cell.height).toBe((1800 / 60) * PPM - 2)
    expect(cell.clippedStart).toBe(true)
  })

  it('clips a program that ends after the window', () => {
    const cell = buildProgramCell(
      makeEvent({ startTime: new Date(metrics.rangeEndMs - 30 * 60_000), duration: 3600 }),
      metrics,
    )
    expect(cell.clippedEnd).toBe(true)
    expect(cell.top).toBe(90 * PPM)
  })

  it('enforces the minimum height for very short programs', () => {
    const cell = buildProgramCell(makeEvent({ duration: 60 }), metrics)
    expect(cell.height).toBe(metrics.minHeight)
  })
})

describe('buildTimeMarks', () => {
  it('aligns marks to the step boundary inside the window', () => {
    const start = RANGE_START + 10 * 60_000
    const end = RANGE_START + 130 * 60_000
    const marks = buildTimeMarks(start, end, 60)
    expect(marks.map((mark) => mark.offsetMinutes)).toEqual([50, 110])
  })
})
