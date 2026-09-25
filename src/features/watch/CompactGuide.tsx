import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../../app/store'
import { buildProgramCell, buildTimeMarks, offsetMinutes } from '../epg/layout'
import { ProgramBlock } from '../epg/ProgramBlock'
import { formatJstTime } from '../epg/time'
import type { ChannelGuideEntry } from '../epg/useEpg'
import { useEpg } from '../epg/useEpg'
import styles from './CompactGuide.module.css'
import timetableStyles from '../epg/timetable.module.css'

const CHANNEL_WIDTH = 116
const TIME_SCALE_WIDTH = 42
const PX_PER_MINUTE = 1.2
const CELL_GAP = 1
const MIN_CELL_HEIGHT = 18
const HOUR_MINUTES = 60
const HALF_HOUR_MINUTES = 30

export function CompactGuide() {
  const { guide, selectChannel } = useEpg(2)
  const currentChannel = useStore((s) => s.receiver.channel)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const didAutoScroll = useRef(false)

  const rangeStartMs = guide.rangeStart.getTime()
  const rangeEndMs = guide.rangeEnd.getTime()
  const nowMs = guide.generatedAt.getTime()
  const totalMinutes = Math.max(1, offsetMinutes(rangeEndMs, rangeStartMs))
  const totalHeight = totalMinutes * PX_PER_MINUTE
  const nowTop = Math.max(0, offsetMinutes(nowMs, rangeStartMs) * PX_PER_MINUTE)

  const hourMarks = useMemo(
    () => buildTimeMarks(rangeStartMs, rangeEndMs, HOUR_MINUTES),
    [rangeStartMs, rangeEndMs],
  )
  const halfHourMarks = useMemo(
    () => buildTimeMarks(rangeStartMs, rangeEndMs, HALF_HOUR_MINUTES),
    [rangeStartMs, rangeEndMs],
  )

  useEffect(() => {
    if (didAutoScroll.current || guide.entries.length === 0) return
    didAutoScroll.current = true
    scrollerRef.current?.scrollTo({ top: Math.max(0, nowTop - 24) })
  }, [guide.entries.length, nowTop])

  if (guide.entries.length === 0) {
    return <div className={styles.empty}>チャンネルが設定されていません</div>
  }

  const renderHeader = (entry: ChannelGuideEntry) => {
    const active = currentChannel === entry.physicalChannel
    return (
      <button
        key={entry.physicalChannel}
        type="button"
        className={active ? styles.channelHeaderActive : styles.channelHeader}
        style={{ width: CHANNEL_WIDTH }}
        onClick={() => selectChannel(entry)}
      >
        <span className={styles.channelNumber}>ch {entry.physicalChannel}</span>
        <span className={styles.channelName}>{entry.serviceName}</span>
      </button>
    )
  }

  const renderColumn = (entry: ChannelGuideEntry) => {
    const active = currentChannel === entry.physicalChannel
    return (
      <div
        key={entry.physicalChannel}
        className={active ? styles.columnActive : styles.column}
        style={{ width: CHANNEL_WIDTH }}
        role="button"
        tabIndex={0}
        aria-label={`${entry.serviceName} を視聴`}
        aria-pressed={active}
        onClick={() => selectChannel(entry)}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
            keyEvent.preventDefault()
            selectChannel(entry)
          }
        }}
      >
        {entry.events.length === 0 && <span className={styles.noProgram}>番組情報なし</span>}
        {entry.events.map((event) => {
          const cell = buildProgramCell(event, {
            rangeStartMs,
            rangeEndMs,
            pixelsPerMinute: PX_PER_MINUTE,
            minHeight: MIN_CELL_HEIGHT,
            gap: CELL_GAP,
          })
          const ended = event.startTime.getTime() + event.duration * 1000 < nowMs
          return (
            <ProgramBlock
              key={event.eventId}
              event={event}
              top={cell.top}
              height={cell.height}
              running={event.running}
              past={ended}
              compact
              interactive={false}
              onClick={() => selectChannel(entry)}
            />
          )
        })}
      </div>
    )
  }

  return (
    <div className={styles.scroller} ref={scrollerRef}>
      <div
        className={styles.inner}
        style={{ width: TIME_SCALE_WIDTH + guide.entries.length * CHANNEL_WIDTH }}
      >
        <div className={styles.headerRow}>
          <div className={styles.corner} style={{ width: TIME_SCALE_WIDTH }} />
          {guide.entries.map(renderHeader)}
        </div>

        <div className={styles.body} style={{ height: totalHeight }}>
          <div
            className={styles.timeScale}
            style={{ width: TIME_SCALE_WIDTH, height: totalHeight }}
          >
            {hourMarks.map((mark) => (
              <span
                key={mark.timeMs}
                className={styles.timeMark}
                style={{ top: mark.offsetMinutes * PX_PER_MINUTE }}
              >
                {formatJstTime(mark.timeMs)}
              </span>
            ))}
          </div>

          <div className={styles.columns} style={{ height: totalHeight }}>
            {halfHourMarks.map((mark) => (
              <span
                key={`half-${mark.timeMs}`}
                className={timetableStyles.halfHourLine}
                style={{ top: mark.offsetMinutes * PX_PER_MINUTE }}
              />
            ))}
            {hourMarks.map((mark) => (
              <span
                key={`hour-${mark.timeMs}`}
                className={timetableStyles.hourLine}
                style={{ top: mark.offsetMinutes * PX_PER_MINUTE }}
              />
            ))}

            {guide.entries.map(renderColumn)}

            <span className={timetableStyles.nowLine} style={{ top: nowTop }}>
              <span className={timetableStyles.nowDot} />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
