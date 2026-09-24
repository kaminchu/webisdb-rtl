import { describe, expect, it } from 'vitest'
import { formatDuration, formatJstDateTime, formatJstRange, formatJstTime } from './time'

describe('JST formatting', () => {
  it('converts UTC to JST (UTC+9)', () => {
    expect(formatJstTime(new Date(Date.UTC(2026, 0, 1, 3, 5)))).toBe('12:05')
    expect(formatJstDateTime(new Date(Date.UTC(2026, 0, 1, 3, 5)))).toBe('01/01 12:05')
  })

  it('rolls over the date at the JST boundary', () => {
    expect(formatJstDateTime(new Date(Date.UTC(2025, 11, 31, 16, 0)))).toBe('01/01 01:00')
  })
})

describe('duration formatting', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(5400)).toBe('1時間30分')
    expect(formatDuration(600)).toBe('10分')
    expect(formatDuration(-1)).toBe('—')
  })

  it('formats a time range', () => {
    expect(formatJstRange(Date.UTC(2026, 0, 1, 3, 0), 3600)).toBe('12:00 〜 13:00')
  })
})
