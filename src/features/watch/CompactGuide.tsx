import { useStore } from '../../app/store'
import { formatJstTime } from '../epg/time'
import { useEpg } from '../epg/useEpg'
import type { ChannelGuideEntry } from '../epg/useEpg'
import styles from './CompactGuide.module.css'

const PX_PER_MINUTE = 6
const LABEL_WIDTH = 104
const TICK_MINUTES = 30

export interface CompactGuideProps {
  onProgramSelect?: () => void
}

export function CompactGuide({ onProgramSelect }: CompactGuideProps) {
  const { guide, selectChannel } = useEpg(2)
  const currentChannel = useStore((s) => s.receiver.channel)

  const nowMs = guide.generatedAt.getTime()
  const rangeStart = guide.rangeStart.getTime()
  const rangeEnd = guide.rangeEnd.getTime()
  const totalMinutes = Math.max(1, (rangeEnd - rangeStart) / 60_000)
  const totalWidth = totalMinutes * PX_PER_MINUTE
  const nowLeft = Math.min(totalWidth, Math.max(0, ((nowMs - rangeStart) / 60_000) * PX_PER_MINUTE))

  const ticks: { left: number; label: string }[] = []
  const firstTick = Math.ceil(rangeStart / (TICK_MINUTES * 60_000)) * TICK_MINUTES * 60_000
  for (let time = firstTick; time <= rangeEnd; time += TICK_MINUTES * 60_000) {
    ticks.push({
      left: ((time - rangeStart) / 60_000) * PX_PER_MINUTE,
      label: formatJstTime(time),
    })
  }

  const select = (entry: ChannelGuideEntry) => {
    selectChannel(entry)
    onProgramSelect?.()
  }

  if (guide.entries.length === 0) {
    return <div className={styles.empty}>チャンネルが設定されていません</div>
  }

  return (
    <div className={styles.scroller}>
      <div className={styles.inner} style={{ minWidth: LABEL_WIDTH + totalWidth }}>
        <div className={styles.headerRow}>
          <div className={styles.labelSpacer} style={{ width: LABEL_WIDTH }} />
          <div className={styles.timeline} style={{ width: totalWidth }}>
            {ticks.map((tick) => (
              <span key={tick.left} className={styles.tick} style={{ left: tick.left }}>
                {tick.label}
              </span>
            ))}
            <span className={styles.nowLine} style={{ left: nowLeft }} />
          </div>
        </div>

        {guide.entries.map((entry) => {
          const active = currentChannel === entry.physicalChannel
          return (
            <div key={entry.physicalChannel} className={styles.row}>
              <button
                type="button"
                className={active ? styles.labelActive : styles.label}
                style={{ width: LABEL_WIDTH }}
                onClick={() => select(entry)}
              >
                <span className={styles.labelChannel}>ch {entry.physicalChannel}</span>
                <span className={styles.labelName}>{entry.serviceName}</span>
              </button>
              <div className={styles.track} style={{ width: totalWidth }}>
                {entry.events.length === 0 ? (
                  <span className={styles.noProgram}>番組情報なし</span>
                ) : (
                  entry.events.map((event) => {
                    const start = event.startTime.getTime()
                    const isRunning = start <= nowMs && start + event.duration * 1000 > nowMs
                    const left = ((start - rangeStart) / 60_000) * PX_PER_MINUTE
                    const width = Math.max(24, (event.duration / 60) * PX_PER_MINUTE - 2)
                    return (
                      <button
                        key={event.eventId}
                        type="button"
                        className={[styles.program, isRunning ? styles.programRunning : '']
                          .filter(Boolean)
                          .join(' ')}
                        style={{ left, width }}
                        title={`${formatJstTime(start)} ${event.title}`}
                        onClick={() => select(entry)}
                      >
                        <span className={styles.programTitle}>
                          {event.title || '（タイトルなし）'}
                        </span>
                      </button>
                    )
                  })
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
