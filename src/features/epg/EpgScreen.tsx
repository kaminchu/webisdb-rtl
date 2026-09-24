import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { formatDuration, formatJstDateTime, formatJstRange } from './time'
import { useEpg } from './useEpg'
import styles from './EpgScreen.module.css'

export function EpgScreen() {
  const { guide, loading, selectProgram, refresh } = useEpg(6)
  const nowMs = guide.generatedAt.getTime()

  return (
    <Panel
      title="番組表"
      actions={
        <Button size="sm" onClick={refresh} disabled={loading}>
          更新
        </Button>
      }
    >
      <div className={styles.stack}>
        <div className={styles.muted}>
          表示範囲 {formatJstDateTime(guide.rangeStart)} 〜 {formatJstDateTime(guide.rangeEnd)}（
          {guide.total} 番組）
        </div>

        {loading ? (
          <div className={styles.empty}>番組情報を読み込んでいます…</div>
        ) : guide.groups.length === 0 ? (
          <div className={styles.empty}>
            番組情報がありません。受信を開始するかチャンネルスキャンを実行してください。
          </div>
        ) : (
          <div className={styles.groups}>
            {guide.groups.map((group) => (
              <section key={group.serviceId} className={styles.group}>
                <h3 className={styles.serviceName}>
                  {group.serviceName}
                  <span className={styles.serviceId}>#{group.serviceId}</span>
                </h3>
                <ul className={styles.programs}>
                  {group.events.map((event) => {
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
                          onClick={() => selectProgram(event)}
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
              </section>
            ))}
          </div>
        )}

        <div className={styles.muted}>
          番組を選択するとサービスを切り替えます（チャンネルが特定できた場合は選局します）。
        </div>
      </div>
    </Panel>
  )
}
