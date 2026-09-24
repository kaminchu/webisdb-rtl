import { useStore } from '../../app/store'
import type { PidStat } from '../../models/si'
import { formatHex, formatNumber, streamTypeLabel } from './format'
import styles from './DebugPanels.module.css'

function sortByPackets(pids: PidStat[]): PidStat[] {
  return pids.toSorted((a, b) => b.packets - a.packets || a.pid - b.pid)
}

export function PidTable() {
  const statistics = useStore((state) => state.diagnostics.tsStatistics)

  if (!statistics || statistics.pids.length === 0) {
    return <div className={styles.empty}>PID 統計がありません。</div>
  }

  const pids = sortByPackets(statistics.pids)

  return (
    <div className={styles.stack}>
      <div className={styles.muted}>
        合計 {formatNumber(statistics.packets)} パケット / {formatNumber(statistics.pids.length)}{' '}
        PID
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">PID</th>
              <th scope="col">パケット数</th>
              <th scope="col">ストリーム種別</th>
            </tr>
          </thead>
          <tbody>
            {pids.map((stat) => (
              <tr key={stat.pid}>
                <td>{formatHex(stat.pid, 4)}</td>
                <td>{formatNumber(stat.packets)}</td>
                <td>{stat.description ?? streamTypeLabel(stat.streamType)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">合計</th>
              <td>{formatNumber(statistics.packets)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}
