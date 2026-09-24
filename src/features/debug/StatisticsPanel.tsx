import { useStore } from '../../app/store'
import {
  formatBitrate,
  formatBytes,
  formatDb,
  formatNumber,
  formatPercent,
  formatSeconds,
} from './format'
import styles from './DebugPanels.module.css'

function StatGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className={styles.metaGrid}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function StatisticsPanel() {
  const statistics = useStore((state) => state.diagnostics.tsStatistics)
  const stats = useStore((state) => state.receiver.stats)
  const diagnostics = useStore((state) => state.diagnostics)

  const tsItems: Array<[string, string]> = statistics
    ? [
        ['TS パケット数', formatNumber(statistics.packets)],
        ['エラーパケット', formatNumber(statistics.packetsWithError)],
        ['CC エラー', formatNumber(statistics.ccErrors)],
        ['ビットレート', formatBitrate(statistics.bitrate)],
        ['TS バイト数', formatBytes(statistics.bytes)],
      ]
    : [['TS 統計', '—']]

  const qualityItems: Array<[string, string]> = [
    ['信号レベル', formatDb(stats.quality.signalLevelDb)],
    ['C/N', formatDb(stats.quality.cnDb)],
    ['MER', formatDb(stats.quality.merDb)],
    ['BER', stats.quality.ber === null ? '—' : stats.quality.ber.toExponential(2)],
    ['パケットエラー', formatNumber(stats.quality.packetErrors)],
    [
      '周波数オフセット',
      stats.quality.frequencyOffsetHz === null
        ? '—'
        : `${stats.quality.frequencyOffsetHz.toFixed(0)} Hz`,
    ],
  ]

  const throughputItems: Array<[string, string]> = [
    ['USB 転送', `${formatBytes(stats.throughput.usbBytesPerSecond)}/s`],
    ['IQ サンプル', `${formatNumber(stats.throughput.iqSamplesPerSecond)}/s`],
    ['TS 出力', `${formatBytes(stats.throughput.tsBytesPerSecond)}/s`],
    ['DSP 使用率', formatPercent(stats.throughput.dspUtilization)],
    ['DSP 処理時間', `${stats.throughput.dspProcessingMsPerSecond.toFixed(1)} ms/s`],
  ]

  const bufferItems: Array<[string, string]> = [
    ['バッファサンプル', formatNumber(stats.buffer.bufferedSamples)],
    ['バッファバイト', formatBytes(stats.buffer.bufferedBytes)],
    ['占有率', formatPercent(stats.buffer.occupancy)],
    ['推定遅延', formatSeconds(stats.buffer.estimatedDelaySeconds)],
    ['破棄サンプル', formatNumber(stats.buffer.droppedSamples)],
    ['入力レート', `${formatNumber(stats.buffer.inputSamplesPerSecond)}/s`],
    ['DSP レート', `${formatNumber(stats.buffer.dspSamplesPerSecond)}/s`],
  ]

  return (
    <div className={styles.stack}>
      <section>
        <h3 className={styles.sectionTitle}>復号の到達状況</h3>
        <StatGrid
          items={[
            ['TMCC', diagnostics.tmcc?.locked ? 'ロック' : '未ロック'],
            ['TS', statistics?.packets ? '取得済み' : '未取得'],
            ['PMT', diagnostics.pmt ? '取得済み' : '未取得'],
            ['映像 PES', formatNumber(diagnostics.pesCounts.video)],
            ['音声 PES', formatNumber(diagnostics.pesCounts.audio)],
          ]}
        />
      </section>
      <section>
        <h3 className={styles.sectionTitle}>TS 統計</h3>
        <StatGrid items={tsItems} />
      </section>
      <section>
        <h3 className={styles.sectionTitle}>受信品質</h3>
        <StatGrid items={qualityItems} />
      </section>
      <section>
        <h3 className={styles.sectionTitle}>スループット</h3>
        <StatGrid items={throughputItems} />
      </section>
      <section>
        <h3 className={styles.sectionTitle}>バッファ</h3>
        <StatGrid items={bufferItems} />
      </section>
      <div className={styles.muted}>稼働時間 {formatSeconds(stats.uptimeSeconds)}</div>
    </div>
  )
}
