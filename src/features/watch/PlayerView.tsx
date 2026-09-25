import type { RefObject } from 'react'
import styles from './WatchScreen.module.css'

export interface PlayerViewProps {
  canvasRef: RefObject<HTMLCanvasElement | null>
  connected: boolean
  connecting: boolean
}

export function PlayerView({ canvasRef, connected, connecting }: PlayerViewProps) {
  return (
    <div className={styles.videoWrap}>
      <canvas ref={canvasRef} className={styles.canvas} aria-label="ワンセグ映像" />
      {!connected && (
        <div className={styles.connectHint} role="status">
          <p className={styles.connectText}>
            {connecting ? '受信機に接続しています…' : '画面をタップして受信を開始してください。'}
          </p>
        </div>
      )}
    </div>
  )
}
