import { useEffect, useMemo, useRef, useState } from 'react'
import { navigate } from '../../app/navigation'
import { Screen, useStore } from '../../app/store'
import { Button } from '../../components/Button'
import { Spinner } from '../../components/Spinner'
import type { Event } from '../../models'
import { MenuButton } from '../shell/MenuButton'
import { buildProgramCell, buildTimeMarks, offsetMinutes } from './layout'
import { ProgramBlock } from './ProgramBlock'
import { ProgramModal } from './ProgramModal'
import { formatJstDateTime, formatJstTime } from './time'
import type { ChannelGuideEntry } from './useEpg'
import { useEpg } from './useEpg'
import { useEpgFetch } from './useEpgFetch'
import styles from './EpgScreen.module.css'
import timetableStyles from './timetable.module.css'

const CHANNEL_WIDTH = 156
const TIME_SCALE_WIDTH = 52
const PX_PER_MINUTE = 1.6
const CELL_GAP = 2
const MIN_CELL_HEIGHT = 22
const HOUR_MINUTES = 60
const HALF_HOUR_MINUTES = 30

interface SelectedProgram {
  event: Event
  entry: ChannelGuideEntry
}

export function EpgScreen() {
  const { guide, loading, selectChannel } = useEpg(6)
  const fetch = useEpgFetch()
  const currentChannel = useStore((s) => s.receiver.channel)
  const [selected, setSelected] = useState<SelectedProgram | null>(null)
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
    if (loading || didAutoScroll.current) return
    didAutoScroll.current = true
    scrollerRef.current?.scrollTo({ top: Math.max(0, nowTop - 80) })
  }, [loading, nowTop])

  const scrollToNow = () => {
    scrollerRef.current?.scrollTo({ top: Math.max(0, nowTop - 80), behavior: 'smooth' })
  }

  const watch = () => {
    if (!selected) return
    selectChannel(selected.entry)
    setSelected(null)
    navigate(Screen.Watch)
  }

  const renderHeader = (entry: ChannelGuideEntry) => {
    const active = currentChannel === entry.physicalChannel
    const fetching = fetch.fetching.includes(entry.physicalChannel)
    return (
      <button
        key={entry.physicalChannel}
        type="button"
        className={active ? styles.channelHeaderActive : styles.channelHeader}
        style={{ width: CHANNEL_WIDTH }}
        onClick={() => selectChannel(entry)}
      >
        <span className={styles.channelNumber}>ch {entry.physicalChannel}</span>
        <span className={styles.channelNameRow}>
          {entry.logo && <span className={styles.channelLogo}>{entry.logo}</span>}
          <span className={styles.channelName}>{entry.serviceName}</span>
          {fetching && <Spinner label={`ch ${entry.physicalChannel} の番組情報を取得中`} />}
        </span>
      </button>
    )
  }

  const renderColumn = (entry: ChannelGuideEntry) => (
    <div key={entry.physicalChannel} className={styles.column} style={{ width: CHANNEL_WIDTH }}>
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
            onClick={() => setSelected({ event, entry })}
          />
        )
      })}
    </div>
  )

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <MenuButton />
        <h1 className={styles.heading}>番組表</h1>
        <span className={styles.range}>
          {formatJstDateTime(guide.rangeStart)} 〜 {formatJstDateTime(guide.rangeEnd)}（
          {guide.total} 番組）
        </span>
        <Button size="sm" onClick={scrollToNow}>
          現在時刻
        </Button>
        {fetch.running ? (
          <Button size="sm" variant="danger" onClick={fetch.cancel}>
            キャンセル
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void fetch.start()}>
            番組表取得
          </Button>
        )}
      </header>

      {loading ? (
        <div className={styles.empty}>番組情報を読み込んでいます…</div>
      ) : guide.entries.length === 0 ? (
        <div className={styles.empty}>
          チャンネルが設定されていません。設定画面のチャンネル設定から選択してください。
        </div>
      ) : (
        <div className={styles.grid} ref={scrollerRef}>
          <div
            className={styles.inner}
            style={{ width: TIME_SCALE_WIDTH + guide.entries.length * CHANNEL_WIDTH }}
          >
            <div className={styles.headerRow}>
              <div className={styles.corner} style={{ width: TIME_SCALE_WIDTH }}>
                時刻
              </div>
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
      )}

      {selected && (
        <ProgramModal
          event={selected.event}
          serviceName={selected.entry.serviceName}
          onClose={() => setSelected(null)}
          onWatch={watch}
        />
      )}
    </div>
  )
}
