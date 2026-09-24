import { useStore } from '../../app/store'
import { codeRateName, timeInterleaveLength, type TransmissionMode } from '../../dsp/isdbtParams'
import type { TmccLayerInfo } from '../../models/tmcc'
import { RawHexView } from './RawHexView'
import { formatHex } from './format'
import styles from './DebugPanels.module.css'

const MODULATION_NAMES: Record<number, string> = {
  0: 'DQPSK',
  1: 'QPSK',
  2: '16QAM',
  3: '64QAM',
}

function modulationName(code: number): string {
  return MODULATION_NAMES[code] ?? `不明 (${code})`
}

function asMode(value: number | null): TransmissionMode | null {
  return value === 1 || value === 2 || value === 3 ? value : null
}

function interleaveLabel(layer: TmccLayerInfo, mode: TransmissionMode | null): string {
  if (mode === null) return '—'
  const length = timeInterleaveLength(layer.timeInterleave, mode)
  return length === 0 ? 'なし' : `${length} シンボル`
}

function LayerRow({
  name,
  layer,
  mode,
}: {
  name: string
  layer: TmccLayerInfo | null
  mode: TransmissionMode | null
}) {
  if (!layer) {
    return (
      <tr>
        <th scope="row">{name}</th>
        <td colSpan={4}>—</td>
      </tr>
    )
  }
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>{modulationName(layer.modulation)}</td>
      <td>{codeRateName(layer.codeRate)}</td>
      <td>{interleaveLabel(layer, mode)}</td>
      <td>{layer.segments}</td>
    </tr>
  )
}

export function TmccPanel() {
  const tmcc = useStore((state) => state.diagnostics.tmcc)

  if (!tmcc) {
    return <div className={styles.empty}>TMCC を取得中です…</div>
  }

  const mode = asMode(tmcc.mode)

  return (
    <div className={styles.stack}>
      <div className={styles.badgeRow}>
        <span className={tmcc.locked ? styles.badgeOk : styles.badgeBad}>
          {tmcc.locked ? 'ロック' : '未ロック'}
        </span>
        <span className={styles.muted}>フレーム {tmcc.frameCount.toLocaleString('ja-JP')}</span>
      </div>

      <dl className={styles.metaGrid}>
        <div>
          <dt>伝送モード</dt>
          <dd>{tmcc.mode === null ? '—' : `モード ${tmcc.mode}`}</dd>
        </div>
        <div>
          <dt>ガードインターバル</dt>
          <dd>{tmcc.guardIntervalRatio === null ? '—' : `1/${tmcc.guardIntervalRatio}`}</dd>
        </div>
        <div>
          <dt>部分受信</dt>
          <dd>{tmcc.partialReception ? 'ワンセグ（部分受信）' : 'なし'}</dd>
        </div>
        <div>
          <dt>システム記述子</dt>
          <dd>{tmcc.systemDescriptor === null ? '—' : formatHex(tmcc.systemDescriptor)}</dd>
        </div>
      </dl>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className={styles.caption}>レイヤ構成</caption>
          <thead>
            <tr>
              <th scope="col">レイヤ</th>
              <th scope="col">変調</th>
              <th scope="col">符号化率</th>
              <th scope="col">時間インターリーブ</th>
              <th scope="col">セグメント数</th>
            </tr>
          </thead>
          <tbody>
            <LayerRow name="A" layer={tmcc.layers.A} mode={mode} />
            <LayerRow name="B" layer={tmcc.layers.B} mode={mode} />
            <LayerRow name="C" layer={tmcc.layers.C} mode={mode} />
          </tbody>
        </table>
      </div>

      <RawHexView data={tmcc.rawBits} title="TMCC 生データ（204 ビット）" bytesPerRow={16} />
    </div>
  )
}
