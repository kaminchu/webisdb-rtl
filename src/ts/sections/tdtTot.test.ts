import { describe, expect, it } from 'vitest'
import { findDescriptor } from '../descriptors'
import { buildTdt, buildTot, encodeJstTime, encodeUtcTime } from '../sectionBuilder'
import { decodeTdt, decodeTot } from './tdtTot'
import { bcdToNumber, numberToBcd, parseDuration, parseJstTime, parseMjdTime } from './tstime'

describe('TDT/TOT', () => {
  it('decodes TDT as UTC', () => {
    const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 5))
    const tdt = decodeTdt(buildTdt(date))
    expect(tdt.utc.getTime()).toBe(date.getTime())
  })

  it('round-trips JST timestamps', () => {
    const instant = new Date(Date.UTC(2024, 0, 1, 15, 0, 0))
    expect(parseJstTime(Uint8Array.from(encodeJstTime(instant))).getTime()).toBe(instant.getTime())
  })

  it('round-trips UTC timestamps through MJD/BCD', () => {
    const epoch = new Date(Date.UTC(1970, 0, 1, 0, 0, 0))
    expect(parseMjdTime(Uint8Array.from(encodeUtcTime(epoch))).getTime()).toBe(0)
  })

  it('decodes TOT with a positive local offset', () => {
    const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 5))
    const tot = decodeTot(buildTot(date, 540, 0))
    expect(tot.utc.getTime()).toBe(date.getTime())
    expect(tot.localTimeOffsetMinutes).toBe(540)
    expect(tot.localTimeOffsetPolarity).toBe(0)
    expect(findDescriptor(tot.descriptors, 0x58)).toBeDefined()
  })

  it('applies the offset polarity', () => {
    const tot = decodeTot(buildTot(new Date(Date.UTC(2024, 0, 2)), 300, 1))
    expect(tot.localTimeOffsetMinutes).toBe(-300)
    expect(tot.localTimeOffsetPolarity).toBe(1)
  })

  it('provides BCD/MJD helpers', () => {
    expect(numberToBcd(59)).toBe(0x59)
    expect(bcdToNumber(0x59)).toBe(59)
    expect(parseDuration(Uint8Array.from([0x01, 0x02, 0x03]))).toBe(3723)
  })
})
