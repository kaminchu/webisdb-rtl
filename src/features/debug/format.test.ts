import { describe, expect, it } from 'vitest'
import {
  formatBitrate,
  formatBytes,
  formatDb,
  formatHex,
  formatHexDump,
  formatNumber,
  formatPercent,
  formatSeconds,
  streamTypeLabel,
} from './format'

describe('formatHexDump', () => {
  it('renders offset, hex and ascii columns', () => {
    expect(formatHexDump(Uint8Array.from([0x00, 0x1f, 0x41]), 3)).toBe('0000  00 1f 41  ..A')
  })

  it('pads short rows and returns empty for empty input', () => {
    expect(formatHexDump(Uint8Array.from([0x41]), 2)).toBe('0000  41     A ')
    expect(formatHexDump(new Uint8Array(0))).toBe('')
  })
})

describe('scalar formatters', () => {
  it('formats hex and numbers', () => {
    expect(formatHex(0x1b)).toBe('0x1b')
    expect(formatHex(5, 4)).toBe('0x0005')
    expect(formatNumber(1234)).toBe('1,234')
    expect(formatNumber(null)).toBe('—')
  })

  it('formats bytes and bitrates', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBitrate(1_500_000)).toBe('1.50 Mbps')
    expect(formatBitrate(1200)).toBe('1.2 kbps')
    expect(formatBitrate(500)).toBe('500 bps')
  })

  it('formats db, percent and seconds', () => {
    expect(formatDb(12.34)).toBe('12.3 dB')
    expect(formatDb(undefined)).toBe('—')
    expect(formatPercent(0.5)).toBe('50.0 %')
    expect(formatSeconds(45)).toBe('45.0 秒')
    expect(formatSeconds(125)).toBe('2 分 5 秒')
  })

  it('describes stream types', () => {
    expect(streamTypeLabel(0x1b)).toBe('AVC video (0x1b)')
    expect(streamTypeLabel(0x99)).toBe('0x99 (0x99)')
    expect(streamTypeLabel(undefined)).toBe('—')
  })
})
