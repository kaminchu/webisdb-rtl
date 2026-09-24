import { useState } from 'react'
import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { StatusBadge } from '../../components/StatusBadge'
import { receiverController } from '../../app/receiverController'
import { useStore } from '../../app/store'
import styles from './ReceiverPanels.module.css'

const usbAvailable = typeof navigator !== 'undefined' && 'usb' in navigator

export function ConnectPanel() {
  const label = useStore((s) => s.receiver.label)
  const state = useStore((s) => s.receiver.state)
  const sourceKind = useStore((s) => s.receiver.sourceKind)
  const error = useStore((s) => s.receiver.error)
  const [connecting, setConnecting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const connect = async () => {
    setConnecting(true)
    setLocalError(null)
    try {
      await receiverController.connectRtlSdr()
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setConnecting(false)
    }
  }

  const connected = sourceKind !== 'none'

  return (
    <Panel title="受信機">
      <div className={styles.stack}>
        <div className={styles.row}>
          <Button
            type="button"
            variant="primary"
            onClick={() => void connect()}
            disabled={!usbAvailable || connecting}
          >
            {connecting ? '接続中…' : 'RTL-SDR に接続'}
          </Button>
          <Button type="button" onClick={() => receiverController.stop()} disabled={!connected}>
            受信停止
          </Button>
          <Button
            type="button"
            onClick={() => receiverController.discardBuffer()}
            disabled={!connected}
          >
            バッファ破棄
          </Button>
        </div>
        {!usbAvailable && <p className={styles.note}>このブラウザは WebUSB に対応していません。</p>}
        <div className={styles.row}>
          <StatusBadge state={state} />
          <span className={styles.label}>{label}</span>
        </div>
        {(localError || error) && (
          <p className={styles.error} role="alert">
            {localError ?? error}
          </p>
        )}
      </div>
    </Panel>
  )
}
