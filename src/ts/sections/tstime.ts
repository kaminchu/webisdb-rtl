export function bcdToNumber(value: number): number {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f)
}

export function numberToBcd(value: number): number {
  return ((Math.floor(value / 10) % 10) << 4) | (value % 10)
}

export interface CalendarDate {
  year: number
  month: number
  day: number
}

/** Convert a Modified Julian Date to a calendar date (UTC). */
export function mjdToCalendar(mjd: number): CalendarDate {
  let year = Math.floor((mjd - 15078.2) / 365.25)
  const month = Math.floor((mjd - 14956.1 - Math.floor(year * 365.25)) / 30.6001)
  const day = mjd - 14956 - Math.floor(year * 365.25) - Math.floor(month * 30.6001)
  const leap = month === 14 || month === 15 ? 1 : 0
  year = year + leap + 1900
  return { year, month: month - 1 - leap * 12, day }
}

export function calendarToMjd(date: CalendarDate): number {
  const a = Math.floor((14 - date.month) / 12)
  const y = date.year + 4800 - a
  const m = date.month + 12 * a - 3
  const jdn =
    date.day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  return jdn - 2400001
}

/** Parse a 5-byte MJD + BCD(HH MM SS) timestamp interpreted as UTC. */
export function parseMjdTime(bytes: Uint8Array, offset = 0): Date {
  const mjd = (bytes[offset] << 8) | bytes[offset + 1]
  const hour = bcdToNumber(bytes[offset + 2])
  const minute = bcdToNumber(bytes[offset + 3])
  const second = bcdToNumber(bytes[offset + 4])
  const { year, month, day } = mjdToCalendar(mjd)
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second))
}

/** Parse a 5-byte MJD + BCD timestamp interpreted as Japan Standard Time (UTC+9). */
export function parseJstTime(bytes: Uint8Array, offset = 0): Date {
  const mjd = (bytes[offset] << 8) | bytes[offset + 1]
  const hour = bcdToNumber(bytes[offset + 2])
  const minute = bcdToNumber(bytes[offset + 3])
  const second = bcdToNumber(bytes[offset + 4])
  const { year, month, day } = mjdToCalendar(mjd)
  return new Date(Date.UTC(year, month - 1, day, hour - 9, minute, second))
}

/** Parse a 3-byte BCD(HH MM SS) duration to seconds. */
export function parseDuration(bytes: Uint8Array, offset = 0): number {
  return (
    bcdToNumber(bytes[offset]) * 3600 +
    bcdToNumber(bytes[offset + 1]) * 60 +
    bcdToNumber(bytes[offset + 2])
  )
}
