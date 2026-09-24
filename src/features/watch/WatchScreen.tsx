import { useEffect, useRef, useState } from 'react'
import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { StatusBadge } from '../../components/StatusBadge'
import { receiverController } from '../../app/receiverController'
import { useStore } from '../../app/store'
import { formatFrequency } from '../../models/channel'
import { OneSegPlayer } from '../../media'
import { BufferPanel } from '../receiver/BufferPanel'
import { ConnectPanel } from '../receiver/ConnectPanel'
import { MetricsPanel } from '../receiver/MetricsPanel'
import { SpectrumView } from '../receiver/SpectrumView'
import { TuningPanel } from '../receiver/TuningPanel'
import { PlayerView } from './PlayerView'
import styles from './WatchScreen.module.css'

export function WatchScreen() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const playerRef = useRef<OneSegPlayer | null>(null)
  const [muted, setMuted] = useState(false)

  const sourceKind = useStore((s) => s.receiver.sourceKind)
  const label = useStore((s) => s.receiver.label)
  const state = useStore((s) => s.receiver.state)
  const channel = useStore((s) => s.receiver.channel)
  const frequency = useStore((s) => s.receiver.frequency)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const player = new OneSegPlayer(canvas)
    playerRef.current = player
    receiverController.setPlayer(player)
    return () => {
      player.close()
      playerRef.current = null
      receiverController.setPlayer(null)
    }
  }, [])

  const connected = sourceKind !== 'none'

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    playerRef.current?.setMuted(next)
  }

  return (
    <div className={styles.layout}>
      <Panel title="ワンセグ視聴" className={styles.wide}>
        <PlayerView canvasRef={canvasRef} connected={connected} />
        <div className={styles.statusLine}>
          <StatusBadge state={state} />
          <span className={styles.label}>{label}</span>
          {channel !== null && <span className={styles.meta}>ch {channel}</span>}
          {frequency > 0 && <span className={styles.meta}>{formatFrequency(frequency)}</span>}
        </div>
        <div className={styles.controls}>
          <Button type="button" variant={muted ? 'default' : 'primary'} onClick={toggleMute}>
            {muted ? 'ミュート解除' : 'ミュート'}
          </Button>
          <Button type="button" onClick={() => receiverController.stop()} disabled={!connected}>
            停止
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => receiverController.discardBuffer()}
            disabled={!connected}
          >
            バッファ破棄
          </Button>
        </div>
      </Panel>
      <ConnectPanel />
      <TuningPanel />
      <Panel title="スペクトラム" className={styles.wide}>
        <SpectrumView />
      </Panel>
      <MetricsPanel />
      <BufferPanel />
    </div>
  )
}
