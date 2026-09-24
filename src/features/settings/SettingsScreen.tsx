import { useEffect, useState } from 'react'
import { Button } from '../../components/Button'
import { Panel } from '../../components/Panel'
import { StatRow } from '../../components/StatRow'
import { receiverController } from '../../app/receiverController'
import { useStore } from '../../app/store'
import { formatFrequency } from '../../models/channel'
import { loadSettings, saveSettings } from '../../storage/settings'
import { IqFilePanel } from '../iqfile/IqFilePanel'
import { RegionSelect } from '../region/RegionSelect'
import styles from './SettingsScreen.module.css'

const SAMPLE_RATES = [
  { value: 1_200_000, label: '1.2 MSps' },
  { value: 2_000_000, label: '2.0 MSps' },
  { value: 2_048_000, label: '2.048 MSps' },
  { value: 2_400_000, label: '2.4 MSps' },
] as const

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} kB`
  return `${bytes} B`
}

function useDumpSizes() {
  const [sizes, setSizes] = useState(() => receiverController.dumpSizes)
  useEffect(() => {
    const id = window.setInterval(() => setSizes(receiverController.dumpSizes), 1000)
    return () => window.clearInterval(id)
  }, [])
  return sizes
}

export function SettingsScreen() {
  const gainDb = useStore((s) => s.receiver.gainDb)
  const sampleRate = useStore((s) => s.receiver.sampleRate)
  const frequency = useStore((s) => s.receiver.frequency)

  const [agc, setAgc] = useState(() => loadSettings().gainDb === null)
  const [gainInput, setGainInput] = useState(() => String(loadSettings().gainDb ?? 19.7))
  const [rate, setRate] = useState(() => loadSettings().sampleRate ?? sampleRate)
  const [spectrum, setSpectrum] = useState(() => loadSettings().debug.spectrum)
  const [iqDump, setIqDump] = useState(false)
  const [tsDump, setTsDump] = useState(false)
  const sizes = useDumpSizes()

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

  const toggleSpectrum = () => {
    const next = !spectrum
    setSpectrum(next)
    receiverController.setSpectrumEnabled(next)
    saveSettings({ debug: { spectrum: next } })
  }

  const toggleIqDump = () => {
    const next = !iqDump
    setIqDump(next)
    receiverController.setIqDumpEnabled(next)
  }

  const toggleTsDump = () => {
    const next = !tsDump
    setTsDump(next)
    receiverController.setTsDumpEnabled(next)
  }

  return (
    <div className={styles.grid}>
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

          <label className={styles.toggle}>
            <input type="checkbox" checked={spectrum} onChange={toggleSpectrum} />
            スペクトラム表示
          </label>
        </div>
      </Panel>

      <Panel title="ダンプ (要件定義書 33)">
        <div className={styles.stack}>
          <label className={styles.toggle}>
            <input type="checkbox" checked={iqDump} onChange={toggleIqDump} />
            IQ を記録
          </label>
          <div className={styles.row}>
            <Button type="button" size="sm" onClick={() => receiverController.saveIqDump()}>
              IQ を保存
            </Button>
            <span className={styles.hint}>{formatBytes(sizes.iqBytes)}</span>
          </div>

          <label className={styles.toggle}>
            <input type="checkbox" checked={tsDump} onChange={toggleTsDump} />
            TS を記録
          </label>
          <div className={styles.row}>
            <Button type="button" size="sm" onClick={() => receiverController.saveTsDump()}>
              TS を保存
            </Button>
            <span className={styles.hint}>{formatBytes(sizes.tsBytes)}</span>
          </div>
        </div>
      </Panel>

      <Panel title="地域・選局">
        <div className={styles.stack}>
          <RegionSelect />
          <StatRow label="現在周波数" value={frequency > 0 ? formatFrequency(frequency) : '—'} />
        </div>
      </Panel>

      <IqFilePanel />
    </div>
  )
}
