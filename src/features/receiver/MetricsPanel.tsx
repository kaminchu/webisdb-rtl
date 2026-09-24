import { Panel } from '../../components/Panel'
import { StatRow } from '../../components/StatRow'
import { useStore } from '../../app/store'
import styles from './ReceiverPanels.module.css'

function formatDecimal(value: number | null, digits: number, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}${unit}`
}

function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond)) return '—'
  const kb = bytesPerSecond / 1000
  return kb >= 1000 ? `${(kb / 1000).toFixed(2)} MB/s` : `${kb.toFixed(1)} kB/s`
}

function formatSamples(perSecond: number): string {
  if (!Number.isFinite(perSecond)) return '—'
  return `${(perSecond / 1_000_000).toFixed(3)} MS/s`
}

export function MetricsPanel() {
  const quality = useStore((s) => s.receiver.stats.quality)
  const throughput = useStore((s) => s.receiver.stats.throughput)

  return (
    <Panel title="受信品質">
      <div className={styles.stack}>
        <div className={styles.stats}>
          <StatRow label="信号レベル" value={formatDecimal(quality.signalLevelDb, 1, ' dB')} />
          <StatRow label="C/N" value={formatDecimal(quality.cnDb, 1, ' dB')} />
          <StatRow label="MER" value={formatDecimal(quality.merDb, 1, ' dB')} />
          <StatRow label="BER" value={quality.ber === null ? '—' : quality.ber.toExponential(2)} />
          <StatRow label="パケット誤り" value={quality.packetErrors.toLocaleString()} />
          <StatRow
            label="周波数オフセット"
            value={formatDecimal(quality.frequencyOffsetHz, 1, ' Hz')}
          />
        </div>
        <div className={styles.stats}>
          <StatRow label="USB" value={formatRate(throughput.usbBytesPerSecond)} />
          <StatRow label="IQ" value={formatSamples(throughput.iqSamplesPerSecond)} />
          <StatRow label="TS" value={formatRate(throughput.tsBytesPerSecond)} />
          <StatRow label="DSP 負荷" value={`${(throughput.dspUtilization * 100).toFixed(0)} %`} />
          <StatRow
            label="DSP 処理時間"
            value={`${throughput.dspProcessingMsPerSecond.toFixed(0)} ms/s`}
          />
        </div>
      </div>
    </Panel>
  )
}
