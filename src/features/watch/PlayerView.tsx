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
        <div className={styles.overlay} role="status">
          <p className={styles.overlayText}>
            受信機を接続するか、IQ ファイルを読み込むと映像・音声が表示されます。
          </p>
        </div>
      )}
    </div>
  )
}
