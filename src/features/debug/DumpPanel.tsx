import { useEffect, useState } from 'react'
import { Button } from '../../components/Button'
import { receiverController } from '../../app/receiverController'
import { formatBytes } from './format'
import styles from './DebugPanels.module.css'

const POLL_INTERVAL_MS = 500

interface DumpSizes {
  iqBytes: number
  tsBytes: number
}

export function DumpPanel() {
  const [iqEnabled, setIqEnabled] = useState(false)
  const [tsEnabled, setTsEnabled] = useState(false)
  const [sizes, setSizes] = useState<DumpSizes>(() => receiverController.dumpSizes)

  useEffect(() => {
    const timer = window.setInterval(() => {
      setSizes((prev) => {
        const next = receiverController.dumpSizes
        if (next.iqBytes === prev.iqBytes && next.tsBytes === prev.tsBytes) return prev
        return next
      })
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  const toggleIq = (enabled: boolean) => {
    setIqEnabled(enabled)
    receiverController.setIqDumpEnabled(enabled)
    setSizes(receiverController.dumpSizes)
  }

  const toggleTs = (enabled: boolean) => {
    setTsEnabled(enabled)
    receiverController.setTsDumpEnabled(enabled)
    setSizes(receiverController.dumpSizes)
  }

  return (
    <div className={styles.stack}>
      <div className={styles.dumpRow}>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={iqEnabled}
            onChange={(event) => toggleIq(event.target.checked)}
          />
          IQ ダンプ
        </label>
        <span className={styles.muted}>{formatBytes(sizes.iqBytes)}</span>
        <Button
          size="sm"
          onClick={() => receiverController.saveIqDump()}
          disabled={sizes.iqBytes === 0}
        >
          IQ を保存
        </Button>
      </div>

      <div className={styles.dumpRow}>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={tsEnabled}
            onChange={(event) => toggleTs(event.target.checked)}
          />
          TS ダンプ
        </label>
        <span className={styles.muted}>{formatBytes(sizes.tsBytes)}</span>
        <Button
          size="sm"
          onClick={() => receiverController.saveTsDump()}
          disabled={sizes.tsBytes === 0}
        >
          TS を保存
        </Button>
      </div>

      <p className={styles.muted}>
        ダンプを有効にすると受信データをメモリに蓄積します。保存するとファイルとしてダウンロードされます。
      </p>
    </div>
  )
}
