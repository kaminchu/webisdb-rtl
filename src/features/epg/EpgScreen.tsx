import { useState } from 'react'
import { navigate } from '../../app/navigation'
import { Screen, useStore } from '../../app/store'
import { Button } from '../../components/Button'
import { MenuButton } from '../shell/MenuButton'
import type { Event } from '../../models'
import type { ChannelGuideEntry } from './useEpg'
import { ProgramModal } from './ProgramModal'
import { formatDuration, formatJstDateTime, formatJstRange } from './time'
import { useEpg } from './useEpg'
import styles from './EpgScreen.module.css'

interface SelectedProgram {
  event: Event
  entry: ChannelGuideEntry
}

export function EpgScreen() {
  const { guide, loading, selectChannel, refresh } = useEpg(6)
  const currentChannel = useStore((s) => s.receiver.channel)
  const [selected, setSelected] = useState<SelectedProgram | null>(null)
  const nowMs = guide.generatedAt.getTime()

  const watch = () => {
    if (!selected) return
    selectChannel(selected.entry)
    setSelected(null)
    navigate(Screen.Watch)
  }

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <MenuButton />
        <h1 className={styles.heading}>番組表</h1>
        <Button size="sm" onClick={refresh} disabled={loading}>
          更新
        </Button>
      </header>

      <div className={styles.muted}>
        表示範囲 {formatJstDateTime(guide.rangeStart)} 〜 {formatJstDateTime(guide.rangeEnd)}（
        {guide.total} 番組）
      </div>

      {loading ? (
        <div className={styles.empty}>番組情報を読み込んでいます…</div>
      ) : guide.entries.length === 0 ? (
        <div className={styles.empty}>
          チャンネルが設定されていません。設定画面のチャンネル設定から選択してください。
        </div>
      ) : (
        <div className={styles.groups}>
          {guide.entries.map((entry) => {
            const active = currentChannel === entry.physicalChannel
            return (
              <section key={entry.physicalChannel} className={styles.group}>
                <button
                  type="button"
                  className={active ? styles.channelHeaderActive : styles.channelHeader}
                  onClick={() => selectChannel(entry)}
                >
                  <span className={styles.channelNumber}>ch {entry.physicalChannel}</span>
                  <span className={styles.channelName}>{entry.serviceName}</span>
                </button>
                {entry.events.length === 0 ? (
                  <div className={styles.noProgram}>番組情報なし</div>
                ) : (
                  <ul className={styles.programs}>
                    {entry.events.map((event) => {
                      const ended = event.startTime.getTime() + event.duration * 1000 < nowMs
                      const classes = [
                        styles.program,
                        event.running ? styles.running : '',
                        ended ? styles.past : '',
                      ]
                        .filter(Boolean)
                        .join(' ')
                      return (
                        <li key={event.eventId}>
                          <button
                            type="button"
                            className={classes}
                            onClick={() => setSelected({ event, entry })}
                            title={event.description}
                          >
                            <span className={styles.programTime}>
                              {formatJstRange(event.startTime, event.duration)}
                            </span>
                            <span className={styles.programTitle}>
                              {event.title || '（タイトルなし）'}
                            </span>
                            <span className={styles.programMeta}>
                              {event.running && <span className={styles.badge}>放送中</span>}
                              {formatDuration(event.duration)}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )
          })}
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
