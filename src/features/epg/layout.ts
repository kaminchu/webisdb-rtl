import type { Event } from '../../models'

const MS_PER_MINUTE = 60_000

/** Pixels per minute of the vertical time axis. */
export interface TimetableMetrics {
  rangeStartMs: number
  rangeEndMs: number
  pixelsPerMinute: number
  minHeight: number
  gap: number
}

export interface ProgramCellLayout {
  top: number
  height: number
  clippedStart: boolean
  clippedEnd: boolean
}

export interface TimeMark {
  timeMs: number
  offsetMinutes: number
}

/** ARIB genre major nibble (high nibble of the content descriptor genre). */
export function genreMajor(genres?: number[]): number {
  const genre = genres?.[0]
  return genre === undefined ? -1 : (genre >> 4) & 0x0f
}

export function offsetMinutes(timeMs: number, rangeStartMs: number): number {
  return (timeMs - rangeStartMs) / MS_PER_MINUTE
}

/** Position and clip a program block against the visible time window. */
export function buildProgramCell(event: Event, metrics: TimetableMetrics): ProgramCellLayout {
  const startMs = event.startTime.getTime()
  const endMs = startMs + event.duration * 1000
  const visibleStart = Math.max(startMs, metrics.rangeStartMs)
  const visibleEnd = Math.min(endMs, metrics.rangeEndMs)
  const top = Math.max(
    0,
    offsetMinutes(visibleStart, metrics.rangeStartMs) * metrics.pixelsPerMinute,
  )
  const rawHeight =
    (Math.max(0, visibleEnd - visibleStart) / MS_PER_MINUTE) * metrics.pixelsPerMinute
  return {
    top,
    height: Math.max(metrics.minHeight, rawHeight - metrics.gap),
    clippedStart: startMs < metrics.rangeStartMs,
    clippedEnd: endMs > metrics.rangeEndMs,
  }
}

/** Time marks aligned to `stepMinutes` boundaries within the visible window. */
export function buildTimeMarks(
  rangeStartMs: number,
  rangeEndMs: number,
  stepMinutes: number,
): TimeMark[] {
  const stepMs = stepMinutes * MS_PER_MINUTE
  const marks: TimeMark[] = []
  for (
    let timeMs = Math.ceil(rangeStartMs / stepMs) * stepMs;
    timeMs <= rangeEndMs;
    timeMs += stepMs
  ) {
    marks.push({ timeMs, offsetMinutes: offsetMinutes(timeMs, rangeStartMs) })
  }
  return marks
}
