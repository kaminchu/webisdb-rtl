import { Panel } from '../../components/Panel'
import { BufferPanel } from '../receiver/BufferPanel'
import { MetricsPanel } from '../receiver/MetricsPanel'
import { SpectrumView } from '../receiver/SpectrumView'
import styles from './DebugOverlay.module.css'

export interface DebugOverlayProps {
  buffer: boolean
  quality: boolean
  spectrum: boolean
}

export function DebugOverlay({ buffer, quality, spectrum }: DebugOverlayProps) {
  if (!buffer && !quality && !spectrum) {
    return <div className={styles.empty}>表示するデバッグ情報が選択されていません</div>
  }
  return (
    <div className={styles.overlay}>
      {quality && <MetricsPanel />}
      {buffer && <BufferPanel />}
      {spectrum && (
        <Panel title="スペクトラム">
          <SpectrumView />
        </Panel>
      )}
    </div>
  )
}
