import { useState } from 'react'
import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { receiverController } from '../../app/receiverController'
import { useStore } from '../../app/store'
import { UHF_CHANNEL_MAX, UHF_CHANNEL_MIN, formatFrequency } from '../../models/channel'
import { loadSettings } from '../../storage/settings'
import { RegionSelect } from '../region/RegionSelect'
import styles from './ReceiverPanels.module.css'

export function TuningPanel() {
  const frequency = useStore((s) => s.receiver.frequency)
  const channel = useStore((s) => s.receiver.channel)
  const [channelInput, setChannelInput] = useState(() => String(loadSettings().lastChannel ?? 19))
  const [frequencyInput, setFrequencyInput] = useState('')

  const tuneChannel = () => {
    const value = Number.parseInt(channelInput, 10)
    if (!Number.isInteger(value) || value < UHF_CHANNEL_MIN || value > UHF_CHANNEL_MAX) return
    void receiverController.tunePhysicalChannel(value)
  }

  const tuneFrequency = () => {
    const mhz = Number.parseFloat(frequencyInput)
    if (!Number.isFinite(mhz) || mhz <= 0) return
    void receiverController.tuneFrequency(Math.round(mhz * 1_000_000))
  }

  return (
    <Panel title="選局">
      <div className={styles.stack}>
        <RegionSelect />
        <div className={styles.field}>
          <label htmlFor="tune-channel">
            物理チャンネル ({UHF_CHANNEL_MIN}–{UHF_CHANNEL_MAX})
          </label>
          <div className={styles.row}>
            <input
              id="tune-channel"
              className={styles.input}
              type="number"
              min={UHF_CHANNEL_MIN}
              max={UHF_CHANNEL_MAX}
              value={channelInput}
              onChange={(event) => setChannelInput(event.target.value)}
            />
            <Button type="button" onClick={tuneChannel}>
              選局
            </Button>
          </div>
        </div>
        <div className={styles.field}>
          <label htmlFor="tune-frequency">周波数 (MHz)</label>
          <div className={styles.row}>
            <input
              id="tune-frequency"
              className={styles.input}
              type="number"
              step="0.001"
              value={frequencyInput}
              onChange={(event) => setFrequencyInput(event.target.value)}
              placeholder="557.143"
            />
            <Button type="button" onClick={tuneFrequency}>
              選局
            </Button>
          </div>
        </div>
        <p className={styles.note}>
          現在: {channel !== null ? `ch ${channel}` : '—'} /{' '}
          {frequency > 0 ? formatFrequency(frequency) : '—'}
        </p>
      </div>
    </Panel>
  )
}
