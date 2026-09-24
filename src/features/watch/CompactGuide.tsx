import { useStore } from '../../app/store'
import type { Event } from '../../models'
import { formatJstTime } from '../epg/time'
import { useEpg } from '../epg/useEpg'
import styles from './CompactGuide.module.css'

const PX_PER_MINUTE = 6
const LABEL_WIDTH = 96
const TICK_MINUTES = 30

export interface CompactGuideProps {
  onProgramSelect?: () => void
}

export function CompactGuide({ onProgramSelect }: CompactGuideProps) {
  const { guide, selectProgram } = useEpg(2)
  const selectedServiceId = useStore((s) => s.diagnostics.selectedServiceId)

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

  const select = (event: Event) => {
    selectProgram(event)
    onProgramSelect?.()
  }

  if (guide.groups.length === 0) {
    return <div className={styles.empty}>番組情報がありません</div>
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

        {guide.groups.map((group) => {
          const active = selectedServiceId === group.serviceId
          const running =
            group.events.find(
              (event) =>
                event.startTime.getTime() <= nowMs &&
                event.startTime.getTime() + event.duration * 1000 > nowMs,
            ) ?? group.events[0]
          return (
            <div key={group.serviceId} className={styles.row}>
              <button
                type="button"
                className={active ? styles.labelActive : styles.label}
                style={{ width: LABEL_WIDTH }}
                onClick={() => running && select(running)}
                disabled={!running}
              >
                {group.serviceName}
              </button>
              <div className={styles.track} style={{ width: totalWidth }}>
                {group.events.map((event) => {
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
                      onClick={() => select(event)}
                    >
                      <span className={styles.programTitle}>
                        {event.title || '（タイトルなし）'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
