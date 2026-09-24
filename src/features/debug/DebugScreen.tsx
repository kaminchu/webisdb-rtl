import { useState } from 'react'
import { Panel } from '../../components/Panel'
import { useStore } from '../../app/store'
import { DumpPanel } from './DumpPanel'
import { PidTable } from './PidTable'
import { PsiSectionTable } from './PsiSectionTable'
import { StatisticsPanel } from './StatisticsPanel'
import { TmccPanel } from './TmccPanel'
import styles from './DebugPanels.module.css'

const TABS = [
  { id: 'statistics', label: '統計' },
  { id: 'tmcc', label: 'TMCC' },
  { id: 'psi', label: 'PSI/SI' },
  { id: 'pid', label: 'PID' },
  { id: 'dump', label: 'ダンプ' },
] as const

type TabId = (typeof TABS)[number]['id']

export function DebugScreen() {
  const [tab, setTab] = useState<TabId>('statistics')
  const pesCounts = useStore((state) => state.diagnostics.pesCounts)
  const selectedServiceId = useStore((state) => state.diagnostics.selectedServiceId)
  const services = useStore((state) => state.diagnostics.services)
  const locked = useStore((state) => state.diagnostics.tmcc?.locked ?? false)

  const selected = services.find((service) => service.serviceId === selectedServiceId)
  const selectedLabel = selected
    ? `${selected.name} (${selected.serviceId})`
    : selectedServiceId === null
      ? '未選択'
      : `サービス ${selectedServiceId}`

  return (
    <Panel
      title="デバッグ"
      actions={
        <span className={locked ? styles.badgeOk : styles.badgeBad}>
          {locked ? 'ロック' : '未ロック'}
        </span>
      }
    >
      <div className={styles.stack}>
        <dl className={styles.summaryGrid}>
          <div>
            <dt>選択サービス</dt>
            <dd>{selectedLabel}</dd>
          </div>
          <div>
            <dt>PES カウント</dt>
            <dd>
              映像 {pesCounts.video} / 音声 {pesCounts.audio} / 字幕 {pesCounts.caption} / データ{' '}
              {pesCounts.data}
            </dd>
          </div>
        </dl>

        <div className={styles.tabs} role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? styles.tabActive : styles.tab}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        {tab === 'statistics' && <StatisticsPanel />}
        {tab === 'tmcc' && <TmccPanel />}
        {tab === 'psi' && <PsiSectionTable />}
        {tab === 'pid' && <PidTable />}
        {tab === 'dump' && <DumpPanel />}
      </div>
    </Panel>
  )
}
