import { describe, expect, it } from 'vitest'
import {
  CaptionRenderer,
  decodeCaptionPayload,
  filterCaptionText,
  isStatementUnit,
  parseCaptionDataUnits,
} from './caption'

const STATEMENT = 0x20
const MANAGEMENT = 0x1f

function unit(id: number, data: number[]): number[] {
  return [id, data.length, ...data]
}

describe('parseCaptionDataUnits', () => {
  it('skips the data identifier and returns known units', () => {
    const payload = Uint8Array.from([
      0x00,
      ...unit(MANAGEMENT, [0x01, 0x00]),
      ...unit(STATEMENT, [0xa2]),
    ])
    const units = parseCaptionDataUnits(payload)
    expect(units).toHaveLength(2)
    expect(units.map((entry) => entry.id)).toEqual([MANAGEMENT, STATEMENT])
    expect(units[1].data).toEqual(Uint8Array.from([0xa2]))
  })

  it('ignores units with an out-of-range size', () => {
    const payload = Uint8Array.from([0x00, STATEMENT, 0x05, 0xa2])
    expect(parseCaptionDataUnits(payload)).toEqual([])
  })

  it('treats missing data identifier as a data unit', () => {
    const payload = Uint8Array.from(unit(STATEMENT, [0xa2]))
    expect(parseCaptionDataUnits(payload)).toHaveLength(1)
  })
})

describe('filterCaptionText', () => {
  it('drops C1 controls and CSI sequences', () => {
    const bytes = Uint8Array.from([0x9b, 0x31, 0x40, 0xa2, 0x85, 0xa4])
    expect(Array.from(filterCaptionText(bytes))).toEqual([0xa2, 0xa4])
  })

  it('keeps escape designations for the text decoder', () => {
    const bytes = Uint8Array.from([0x1b, 0x28, 0x4a, 0x41])
    expect(Array.from(filterCaptionText(bytes))).toEqual([0x1b, 0x28, 0x4a, 0x41])
  })
})

describe('decodeCaptionPayload', () => {
  it('decodes a hiragana statement', () => {
    const payload = Uint8Array.from([0x00, ...unit(STATEMENT, [0xa2])])
    expect(decodeCaptionPayload(payload)).toBe('あ')
  })

  it('returns null when there is no statement unit', () => {
    const payload = Uint8Array.from([0x00, ...unit(MANAGEMENT, [0x01, 0x00])])
    expect(decodeCaptionPayload(payload)).toBeNull()
  })

  it('identifies statement units', () => {
    expect(isStatementUnit({ id: STATEMENT, data: Uint8Array.from([]) })).toBe(true)
    expect(isStatementUnit({ id: MANAGEMENT, data: Uint8Array.from([]) })).toBe(false)
  })
})

describe('CaptionRenderer', () => {
  it('stores the latest statement and clears on demand', () => {
    const renderer = new CaptionRenderer({ ttlMs: 1000 })
    renderer.set('こんにちは')
    expect(renderer.current).toBe('こんにちは')
    renderer.clear()
    expect(renderer.current).toBe('')
  })

  it('ignores null without replacing the current text', () => {
    const renderer = new CaptionRenderer()
    renderer.set('表示中')
    renderer.set(null)
    expect(renderer.current).toBe('')
  })
})
