import { useMemo, useState } from 'react'
import { receiverController } from '../../app/receiverController'
import {
  getChannelsByTransmitter,
  getTransmittersByRegion,
  loadRegions,
} from '../../data/japan/loader'
import { loadSettings, saveSettings } from '../../storage/settings'
import styles from './RegionSelect.module.css'

export function RegionSelect() {
  const regions = useMemo(() => loadRegions(), [])
  const [regionId, setRegionId] = useState(
    () => loadSettings().lastRegionId ?? regions[0]?.id ?? '',
  )
  const [transmitterId, setTransmitterId] = useState('')

  const transmitters = useMemo(
    () => (regionId ? getTransmittersByRegion(regionId) : []),
    [regionId],
  )
  const effectiveTransmitterId = transmitterId || transmitters[0]?.id || ''
  const channels = useMemo(
    () => (effectiveTransmitterId ? getChannelsByTransmitter(effectiveTransmitterId) : []),
    [effectiveTransmitterId],
  )

  const changeRegion = (id: string) => {
    setRegionId(id)
    setTransmitterId('')
    saveSettings({ lastRegionId: id })
  }

  return (
    <div className={styles.stack}>
      <div className={styles.field}>
        <label htmlFor="region-select">地域</label>
        <select
          id="region-select"
          className={styles.select}
          value={regionId}
          onChange={(event) => changeRegion(event.target.value)}
        >
          {regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.prefecture} {region.name}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="transmitter-select">送信所</label>
        <select
          id="transmitter-select"
          className={styles.select}
          value={effectiveTransmitterId}
          onChange={(event) => setTransmitterId(event.target.value)}
          disabled={transmitters.length === 0}
        >
          {transmitters.map((transmitter) => (
            <option key={transmitter.id} value={transmitter.id}>
              {transmitter.name}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <span>チャンネル</span>
        <div className={styles.channels}>
          {channels.length === 0 && <span className={styles.empty}>チャンネルがありません</span>}
          {channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              className={styles.channel}
              onClick={() => void receiverController.tunePhysicalChannel(channel.physicalChannel)}
            >
              ch {channel.physicalChannel}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
