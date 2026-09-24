import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { ProgressBar } from '../../components/ProgressBar'
import { StatRow } from '../../components/StatRow'
import { receiverController } from '../../app/receiverController'
import { useStore } from '../../app/store'
import styles from './ReceiverPanels.module.css'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} kB`
  return `${bytes} B`
}

export function BufferPanel() {
  const buffer = useStore((s) => s.receiver.stats.buffer)

  return (
    <Panel title="バッファ">
      <div className={styles.stack}>
        <ProgressBar
          value={buffer.occupancy}
          label="バッファ使用率"
          tone={buffer.occupancy > 0.8 ? 'warn' : 'good'}
        />
        <div className={styles.stats}>
          <StatRow label="推定遅延" value={`${buffer.estimatedDelaySeconds.toFixed(2)} 秒`} />
          <StatRow label="サンプル数" value={buffer.bufferedSamples.toLocaleString()} />
          <StatRow label="サイズ" value={formatBytes(buffer.bufferedBytes)} />
          <StatRow label="ドロップ" value={buffer.droppedSamples.toLocaleString()} />
        </div>
        <Button type="button" onClick={() => receiverController.discardBuffer()}>
          LIVE に戻る / バッファを破棄
        </Button>
      </div>
    </Panel>
  )
}
