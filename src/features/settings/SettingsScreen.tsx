import { useState } from 'react'
import { receiverController } from '../../app/receiverController'
import { useStore } from '../../app/store'
import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { loadSettings, MAX_BUFFER_SECONDS, saveSettings } from '../../storage/settings'
import { MenuButton } from '../shell/MenuButton'
import { ChannelSettings } from './ChannelSettings'
import styles from './SettingsScreen.module.css'

const SAMPLE_RATES = [
  { value: 1_200_000, label: '1.2 MSps' },
  { value: 2_000_000, label: '2.0 MSps' },
  { value: 2_048_000, label: '2.048 MSps' },
  { value: 2_400_000, label: '2.4 MSps' },
] as const

export function SettingsScreen() {
  const gainDb = useStore((s) => s.receiver.gainDb)
  const sampleRate = useStore((s) => s.receiver.sampleRate)

  const [agc, setAgc] = useState(() => loadSettings().gainDb === null)
  const [gainInput, setGainInput] = useState(() => String(loadSettings().gainDb ?? 19.7))
  const [rate, setRate] = useState(() => loadSettings().sampleRate ?? sampleRate)
  const [bufferInput, setBufferInput] = useState(() => String(loadSettings().bufferSeconds))
  const [subtitles, setSubtitles] = useState(() => loadSettings().ui.subtitles)
  const [showOverlay, setShowOverlay] = useState(() => loadSettings().debug.showOverlay)
  const [overlayBuffer, setOverlayBuffer] = useState(() => loadSettings().debug.overlayBuffer)
  const [overlayQuality, setOverlayQuality] = useState(() => loadSettings().debug.overlayQuality)
  const [overlaySpectrum, setOverlaySpectrum] = useState(() => loadSettings().debug.overlaySpectrum)

  const applyGain = () => {
    const value = Number.parseFloat(gainInput)
    if (!Number.isFinite(value)) return
    setAgc(false)
    receiverController.setGain(value)
  }

  const enableAgc = () => {
    setAgc(true)
    receiverController.setGain('auto')
  }

  const changeRate = (value: number) => {
    setRate(value)
    saveSettings({ sampleRate: value })
  }

  const changeBuffer = (raw: string) => {
    setBufferInput(raw)
    const value = Number.parseFloat(raw)
    if (!Number.isFinite(value) || value < 0) return
    saveSettings({ bufferSeconds: Math.min(value, MAX_BUFFER_SECONDS) })
  }

  const toggleSubtitles = () => {
    const next = !subtitles
    setSubtitles(next)
    saveSettings({ ui: { subtitles: next } })
  }

  const toggleOverlay = () => {
    const next = !showOverlay
    setShowOverlay(next)
    saveSettings({ debug: { showOverlay: next } })
  }

  const toggleOverlayBuffer = () => {
    const next = !overlayBuffer
    setOverlayBuffer(next)
    saveSettings({ debug: { overlayBuffer: next } })
  }

  const toggleOverlayQuality = () => {
    const next = !overlayQuality
    setOverlayQuality(next)
    saveSettings({ debug: { overlayQuality: next } })
  }

  const toggleOverlaySpectrum = () => {
    const next = !overlaySpectrum
    setOverlaySpectrum(next)
    saveSettings({ debug: { overlaySpectrum: next } })
    receiverController.setSpectrumEnabled(next)
  }

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <MenuButton />
        <h1 className={styles.heading}>設定</h1>
      </header>

      <div className={styles.grid}>
        <div className={styles.wide}>
          <ChannelSettings />
        </div>

        <Panel title="表示設定">
          <div className={styles.stack}>
            <label className={styles.toggle}>
              <input type="checkbox" checked={subtitles} onChange={toggleSubtitles} />
              字幕を表示する（全体設定）
            </label>
            <label className={styles.toggle}>
              <input type="checkbox" checked={showOverlay} onChange={toggleOverlay} />
              デバッグ情報を視聴画面にオーバーレイする
            </label>
            <div className={styles.nested}>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={overlayBuffer}
                  disabled={!showOverlay}
                  onChange={toggleOverlayBuffer}
                />
                バッファ
              </label>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={overlayQuality}
                  disabled={!showOverlay}
                  onChange={toggleOverlayQuality}
                />
                受信品質
              </label>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={overlaySpectrum}
                  disabled={!showOverlay}
                  onChange={toggleOverlaySpectrum}
                />
                スペクトラム
              </label>
            </div>
          </div>
        </Panel>

        <Panel title="再生設定">
          <div className={styles.stack}>
            <div className={styles.field}>
              <label htmlFor="buffer-seconds">再生バッファ (秒)</label>
              <input
                id="buffer-seconds"
                className={styles.input}
                type="number"
                min={0}
                max={MAX_BUFFER_SECONDS}
                step={0.5}
                value={bufferInput}
                onChange={(event) => changeBuffer(event.target.value)}
              />
              <span className={styles.hint}>
                受信からこの秒数だけ遅らせて再生し、途切れを抑えます（視聴画面を開き直すと適用）。
              </span>
            </div>
          </div>
        </Panel>

        <Panel title="受信設定">
          <div className={styles.stack}>
            <div className={styles.field}>
              <span>ゲイン (dB)</span>
              <div className={styles.row}>
                <input
                  className={styles.input}
                  type="number"
                  step="0.1"
                  value={gainInput}
                  onChange={(event) => setGainInput(event.target.value)}
                  aria-label="ゲイン (dB)"
                />
                <Button type="button" onClick={applyGain}>
                  適用
                </Button>
                <Button type="button" variant={agc ? 'primary' : 'default'} onClick={enableAgc}>
                  AGC
                </Button>
              </div>
              <span className={styles.hint}>
                現在: {gainDb === null ? 'AGC' : `${gainDb.toFixed(1)} dB`}
              </span>
            </div>

            <div className={styles.field}>
              <label htmlFor="sample-rate">サンプルレート</label>
              <select
                id="sample-rate"
                className={styles.select}
                value={rate}
                onChange={(event) => changeRate(Number(event.target.value))}
              >
                {SAMPLE_RATES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className={styles.hint}>
                現在: {(sampleRate / 1_000_000).toFixed(3)} MSps（再接続時に適用）
              </span>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  )
}
