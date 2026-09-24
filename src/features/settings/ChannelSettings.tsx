import { useMemo, useState } from 'react'
import { store, useStore } from '../../app/store'
import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import {
  configuredChannelsForTransmitter,
  findNearestTransmitter,
  getTransmittersByRegion,
  loadRegions,
} from '../../data/japan/loader'
import type { ConfiguredChannel } from '../../models'
import { saveConfiguredChannels } from '../../storage/channels'
import { loadSettings, saveSettings } from '../../storage/settings'
import { useChannelScan } from '../scan/useChannelScan'
import styles from './SettingsScreen.module.css'

type Mode = 'region' | 'scan'

const CHANNEL_MIN = 13
const CHANNEL_MAX = 52

function mergeChannels(
  current: ConfiguredChannel[],
  incoming: ConfiguredChannel[],
): ConfiguredChannel[] {
  const map = new Map<number, ConfiguredChannel>()
  for (const channel of [...current, ...incoming]) {
    if (!map.has(channel.physicalChannel)) map.set(channel.physicalChannel, channel)
  }
  return [...map.values()].toSorted((a, b) => a.physicalChannel - b.physicalChannel)
}

function applyChannels(next: ConfiguredChannel[]): void {
  const saved = saveConfiguredChannels(next)
  store.setState({ configuredChannels: saved })
}

export function ChannelSettings() {
  const channels = useStore((s) => s.configuredChannels)
  const regions = useMemo(() => loadRegions(), [])
  const [mode, setMode] = useState<Mode>('region')
  const [regionId, setRegionId] = useState(
    () => loadSettings().lastRegionId ?? regions[0]?.id ?? '',
  )
  const [transmitterId, setTransmitterId] = useState('')
  const [gpsStatus, setGpsStatus] = useState<string | null>(null)
  const scan = useChannelScan()

  const transmitters = useMemo(
    () => (regionId ? getTransmittersByRegion(regionId) : []),
    [regionId],
  )
  const effectiveTransmitterId = transmitterId || transmitters[0]?.id || ''
  const offered = useMemo(
    () => (effectiveTransmitterId ? configuredChannelsForTransmitter(effectiveTransmitterId) : []),
    [effectiveTransmitterId],
  )

  const has = (physicalChannel: number) =>
    channels.some((channel) => channel.physicalChannel === physicalChannel)

  const toggle = (channel: ConfiguredChannel) => {
    if (has(channel.physicalChannel)) {
      applyChannels(channels.filter((entry) => entry.physicalChannel !== channel.physicalChannel))
    } else {
      applyChannels(mergeChannels(channels, [channel]))
    }
  }

  const changeRegion = (id: string) => {
    setRegionId(id)
    setTransmitterId('')
    saveSettings({ lastRegionId: id })
  }

  const locate = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsStatus('この端末では位置情報を利用できません')
      return
    }
    setGpsStatus('位置情報を取得しています…')
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nearest = findNearestTransmitter(position.coords.latitude, position.coords.longitude)
        if (!nearest) {
          setGpsStatus('近くの送信所が見つかりませんでした')
          return
        }
        setRegionId(nearest.regionId)
        setTransmitterId(nearest.id)
        saveSettings({ lastRegionId: nearest.regionId })
        const offeredChannels = configuredChannelsForTransmitter(nearest.id)
        if (offeredChannels.length === 0) {
          setGpsStatus(`${nearest.name} のチャンネル情報がありません。スキャンをご利用ください。`)
          return
        }
        applyChannels(mergeChannels(channels, offeredChannels))
        setGpsStatus(`${nearest.name}（${nearest.regionId}）のチャンネルを追加しました`)
      },
      () => setGpsStatus('位置情報を取得できませんでした'),
      { timeout: 10000 },
    )
  }

  const scanChannelConfig = (physicalChannel: number): ConfiguredChannel => {
    const result = scan.results.find((entry) => entry.physicalChannel === physicalChannel)
    const services = result?.services ?? []
    const channel: ConfiguredChannel = { physicalChannel }
    if (services.length === 1) {
      channel.name = services[0].name
      channel.serviceId = services[0].serviceId
    } else if (services.length > 1) {
      channel.name = services.map((service) => service.name).join('、')
    }
    return channel
  }

  return (
    <Panel title="チャンネル設定">
      <div className={styles.stack}>
        <div className={styles.segmented} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'region'}
            className={mode === 'region' ? styles.segmentActive : styles.segment}
            onClick={() => setMode('region')}
          >
            地域・送信所から選ぶ
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'scan'}
            className={mode === 'scan' ? styles.segmentActive : styles.segment}
            onClick={() => setMode('scan')}
          >
            チャンネルスキャンで選ぶ
          </button>
        </div>

        {mode === 'region' ? (
          <div className={styles.stack}>
            <div className={styles.field}>
              <label htmlFor="channel-region">地域</label>
              <select
                id="channel-region"
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
              <label htmlFor="channel-transmitter">送信所</label>
              <select
                id="channel-transmitter"
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
            <Button type="button" size="sm" onClick={locate}>
              現在地から自動選択 (GPS)
            </Button>
            {gpsStatus && <p className={styles.hint}>{gpsStatus}</p>}

            <div className={styles.checkList}>
              {offered.length === 0 ? (
                <p className={styles.hint}>この送信所のチャンネル情報がありません。</p>
              ) : (
                offered.map((channel) => (
                  <label key={channel.physicalChannel} className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={has(channel.physicalChannel)}
                      onChange={() => toggle(channel)}
                    />
                    <span className={styles.checkChannel}>ch {channel.physicalChannel}</span>
                    <span className={styles.checkName}>{channel.name ?? '—'}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        ) : (
          <div className={styles.stack}>
            <div className={styles.row}>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={scan.running}
                onClick={() => void scan.start({ from: CHANNEL_MIN, to: CHANNEL_MAX })}
              >
                {scan.running ? 'スキャン中…' : 'スキャン開始'}
              </Button>
              {scan.running && (
                <Button type="button" variant="danger" size="sm" onClick={scan.cancel}>
                  キャンセル
                </Button>
              )}
            </div>
            {scan.error && <p className={styles.error}>{scan.error}</p>}
            <div className={styles.checkList}>
              {scan.results.length === 0 ? (
                <p className={styles.hint}>スキャン結果がありません。</p>
              ) : (
                scan.results.map((result) => (
                  <label key={result.physicalChannel} className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={has(result.physicalChannel)}
                      onChange={() => toggle(scanChannelConfig(result.physicalChannel))}
                    />
                    <span className={styles.checkChannel}>ch {result.physicalChannel}</span>
                    <span className={styles.checkName}>
                      {result.services.length > 0
                        ? result.services.map((service) => service.name).join('、')
                        : result.succeeded
                          ? '受信'
                          : '—'}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}

        <div className={styles.configuredHeader}>
          <span>選択中のチャンネル（{channels.length}）</span>
        </div>
        {channels.length === 0 ? (
          <p className={styles.hint}>
            チャンネルが未設定です。地域・送信所から選ぶか、スキャンで追加してください。
          </p>
        ) : (
          <div className={styles.chips}>
            {channels.map((channel) => (
              <span key={channel.physicalChannel} className={styles.chip}>
                ch {channel.physicalChannel}
                {channel.name ? ` ${channel.name}` : ''}
                <button
                  type="button"
                  className={styles.chipRemove}
                  aria-label={`ch ${channel.physicalChannel} を削除`}
                  onClick={() => toggle(channel)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </Panel>
  )
}
