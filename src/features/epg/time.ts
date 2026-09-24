const JST_OFFSET_MS = 9 * 60 * 60 * 1000

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}

function toJstParts(value: Date | number) {
  const date = new Date((value instanceof Date ? value.getTime() : value) + JST_OFFSET_MS)
  return {
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
  }
}

/** Format a Date as `MM/DD HH:mm` in Japan Standard Time (UTC+9, no DST). */
export function formatJstDateTime(value: Date | number): string {
  const parts = toJstParts(value)
  return `${pad(parts.month)}/${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`
}

/** Format a Date as `HH:mm` in Japan Standard Time. */
export function formatJstTime(value: Date | number): string {
  const parts = toJstParts(value)
  return `${pad(parts.hour)}:${pad(parts.minute)}`
}

/** Format a duration in seconds as Japanese hours/minutes. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return `${hours}時間${minutes}分`
  return `${minutes}分`
}

/** Format a program's start and end time (JST) as a range. */
export function formatJstRange(start: Date | number, durationSeconds: number): string {
  const startMs = start instanceof Date ? start.getTime() : start
  return `${formatJstTime(startMs)} 〜 ${formatJstTime(startMs + durationSeconds * 1000)}`
}
