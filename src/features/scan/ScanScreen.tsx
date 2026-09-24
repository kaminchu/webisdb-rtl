import { useState } from 'react'
import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { useStore } from '../../app/store'
import { UHF_CHANNEL_MAX, UHF_CHANNEL_MIN, formatFrequency } from '../../models/channel'
import { formatDb, formatHex, formatNumber } from '../debug/format'
import { useChannelScan } from './useChannelScan'
import styles from './ScanScreen.module.css'

function clampChannel(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(UHF_CHANNEL_MAX, Math.max(UHF_CHANNEL_MIN, Math.round(value)))
}

export function ScanScreen() {
  const [from, setFrom] = useState(UHF_CHANNEL_MIN)
  const [to, setTo] = useState(UHF_CHANNEL_MAX)
  const sourceKind = useStore((state) => state.receiver.sourceKind)
  const { running, progress, results, error, start, cancel } = useChannelScan()

  const ready = sourceKind !== 'none'
  const percent = progress ? Math.round((progress.current / progress.total) * 100) : 0
  const received = results.filter((result) => result.succeeded).length

  return (
    <Panel
      title="チャンネルスキャン"
      actions={
        running ? (
          <Button variant="danger" size="sm" onClick={cancel}>
            キャンセル
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!ready}
            onClick={() => void start({ from, to })}
          >
            スキャン開始
          </Button>
        )
      }
    >
      <div className={styles.stack}>
        <div className={styles.controls}>
          <label className={styles.field}>
            <span>開始チャンネル</span>
            <input
              className={styles.input}
              type="number"
              min={UHF_CHANNEL_MIN}
              max={UHF_CHANNEL_MAX}
              value={from}
              disabled={running}
              onChange={(event) => setFrom(Number(event.target.value))}
              onBlur={() => setFrom((value) => clampChannel(value, UHF_CHANNEL_MIN))}
            />
          </label>
          <label className={styles.field}>
            <span>終了チャンネル</span>
            <input
              className={styles.input}
              type="number"
              min={UHF_CHANNEL_MIN}
              max={UHF_CHANNEL_MAX}
              value={to}
              disabled={running}
              onChange={(event) => setTo(Number(event.target.value))}
              onBlur={() => setTo((value) => clampChannel(value, UHF_CHANNEL_MAX))}
            />
          </label>
          <span className={styles.muted}>
            対象 {UHF_CHANNEL_MIN}ch〜{UHF_CHANNEL_MAX}ch（地上デジタル）
          </span>
        </div>

        {!ready && (
          <div className={styles.notice}>
            受信機を接続するか IQ ファイルを開いてからスキャンしてください。
          </div>
        )}

        {error && <div className={styles.error}>{error}</div>}

        {running && progress && (
          <div className={styles.progressBlock}>
            <div className={styles.progressLabel}>
              チャンネル {progress.channel}ch をスキャン中（{progress.current}/{progress.total}）
            </div>
            <div className={styles.progressTrack}>
              <div className={styles.progressBar} style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}

        {results.length === 0 ? (
          <div className={styles.empty}>スキャン結果がありません。スキャンを開始してください。</div>
        ) : (
          <>
            <div className={styles.muted}>
              {results.length} チャンネル中 {received} チャンネルで受信を確認
            </div>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">物理ch</th>
                    <th scope="col">周波数</th>
                    <th scope="col">受信</th>
                    <th scope="col">サービス</th>
                    <th scope="col">信号</th>
                    <th scope="col">C/N</th>
                    <th scope="col">MER</th>
                    <th scope="col">TSID</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr key={result.physicalChannel}>
                      <td>{result.physicalChannel}</td>
                      <td>{formatFrequency(result.frequency)}</td>
                      <td>
                        <span className={result.succeeded ? styles.ok : styles.ng}>
                          {result.succeeded ? '受信' : '—'}
                        </span>
                      </td>
                      <td className={styles.services}>
                        {result.services.length > 0
                          ? result.services.map((service) => service.name).join('、')
                          : '—'}
                      </td>
                      <td>{formatDb(result.signalLevelDb)}</td>
                      <td>{formatDb(result.cnDb)}</td>
                      <td>{formatDb(result.merDb)}</td>
                      <td>
                        {result.transportStreamId === null
                          ? '—'
                          : formatHex(result.transportStreamId, 4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.muted}>
              結果はスキャン結果ストア（利用できない場合はローカルストレージ）に保存されます。 合計{' '}
              {formatNumber(results.length)} 件。
            </div>
          </>
        )}
      </div>
    </Panel>
  )
}
