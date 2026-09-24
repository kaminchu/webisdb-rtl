import { useState } from 'react'
import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { receiverController } from '../../app/receiverController'
import { isIqMetadata } from '../../iq/iqFormat'
import type { IqMetadata } from '../../iq/iqFormat'
import styles from './IqFilePanel.module.css'

const DEFAULT_SAMPLE_RATE = 1_200_000

export function IqFilePanel() {
  const [iqFile, setIqFile] = useState<File | null>(null)
  const [metaFile, setMetaFile] = useState<File | null>(null)
  const [manualMhz, setManualMhz] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const open = async () => {
    if (!iqFile) {
      setError('IQ ファイルを選択してください。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const buffer = await iqFile.arrayBuffer()
      let metadata: IqMetadata
      if (metaFile) {
        const parsed: unknown = JSON.parse(await metaFile.text())
        if (!isIqMetadata(parsed)) {
          setError('メタデータファイルの形式が正しくありません。')
          return
        }
        metadata = parsed
      } else {
        const mhz = Number.parseFloat(manualMhz)
        if (!Number.isFinite(mhz) || mhz <= 0) {
          setError('中心周波数 (MHz) を入力してください。')
          return
        }
        metadata = {
          version: 1,
          format: 'u8',
          sampleRate: DEFAULT_SAMPLE_RATE,
          centerFrequency: Math.round(mhz * 1_000_000),
          gainDb: null,
          ppm: 0,
          timestamp: new Date().toISOString(),
          device: 'manual',
          tuner: 'unknown',
        }
      }
      await receiverController.openIqFile(new Uint8Array(buffer), metadata, iqFile.name)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="IQ ファイル再生">
      <div className={styles.stack}>
        <div className={styles.field}>
          <label htmlFor="iq-file">IQ ファイル (.iq)</label>
          <input
            id="iq-file"
            className={styles.input}
            type="file"
            accept=".iq,application/octet-stream"
            onChange={(event) => setIqFile(event.target.files?.[0] ?? null)}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="iq-meta">メタデータ (.iq.json, 任意)</label>
          <input
            id="iq-meta"
            className={styles.input}
            type="file"
            accept=".json,application/json"
            onChange={(event) => setMetaFile(event.target.files?.[0] ?? null)}
          />
        </div>
        {!metaFile && (
          <div className={styles.field}>
            <label htmlFor="iq-manual-freq">中心周波数 (MHz)</label>
            <input
              id="iq-manual-freq"
              className={styles.input}
              type="number"
              step="0.001"
              value={manualMhz}
              onChange={(event) => setManualMhz(event.target.value)}
              placeholder="557.143"
            />
          </div>
        )}
        <div className={styles.row}>
          <Button
            type="button"
            variant="primary"
            onClick={() => void open()}
            disabled={busy || !iqFile}
          >
            {busy ? '読み込み中…' : '読み込む'}
          </Button>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Panel>
  )
}
