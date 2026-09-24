import type { RefObject } from 'react'
import styles from './WatchScreen.module.css'

export interface PlayerViewProps {
  canvasRef: RefObject<HTMLCanvasElement | null>
  connected: boolean
}

export function PlayerView({ canvasRef, connected }: PlayerViewProps) {
  return (
    <div className={styles.videoWrap}>
      <canvas ref={canvasRef} className={styles.canvas} aria-label="ワンセグ映像" />
      {!connected && (
        <div className={styles.connectHint} role="status">
          <p className={styles.connectText}>
            受信機または IQ ファイルは「設定」画面から接続できます。
          </p>
        </div>
      )}
    </div>
  )
}
