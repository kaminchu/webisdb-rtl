import { useState, type ReactNode } from 'react'
import { useStore } from '../../app/store'
import { formatJstDateTime, formatJstTime } from '../epg/time'
import { formatHex, formatNumber, streamTypeLabel } from './format'
import styles from './DebugPanels.module.css'

const TABS = [
  { id: 'pat', label: 'PAT' },
  { id: 'pmt', label: 'PMT' },
  { id: 'sdt', label: 'SDT' },
  { id: 'eit', label: 'EIT' },
  { id: 'nit', label: 'NIT' },
  { id: 'tdt', label: 'TDT' },
  { id: 'tot', label: 'TOT' },
] as const

type TabId = (typeof TABS)[number]['id']

function DataTable({ columns, rows }: { columns: string[]; rows: ReactNode[][] }) {
  if (rows.length === 0) return <div className={styles.empty}>データがありません。</div>
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MetaList({ items }: { items: Array<[string, ReactNode]> }) {
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

export function PsiSectionTable() {
  const [tab, setTab] = useState<TabId>('pat')
  const pat = useStore((state) => state.diagnostics.pat)
  const pmt = useStore((state) => state.diagnostics.pmt)
  const sdt = useStore((state) => state.diagnostics.sdt)
  const eit = useStore((state) => state.diagnostics.eit)
  const nit = useStore((state) => state.diagnostics.nit)
  const tdt = useStore((state) => state.diagnostics.tdt)
  const tot = useStore((state) => state.diagnostics.tot)

  const renderPat = () => {
    if (!pat) return <div className={styles.empty}>PAT 未受信</div>
    return (
      <div className={styles.stack}>
        <MetaList
          items={[
            ['TSID', formatHex(pat.transportStreamId, 4)],
            ['バージョン', formatNumber(pat.version)],
            ['NIT PID', formatHex(pat.networkPid, 4)],
          ]}
        />
        <DataTable
          columns={['プログラム番号', 'PMT PID']}
          rows={pat.programs.map((program) => [program.programNumber, formatHex(program.pid, 4)])}
        />
      </div>
    )
  }

  const renderPmt = () => {
    if (!pmt) return <div className={styles.empty}>PMT 未受信</div>
    return (
      <div className={styles.stack}>
        <MetaList
          items={[
            ['プログラム番号', formatNumber(pmt.programNumber)],
            ['バージョン', formatNumber(pmt.version)],
            ['PCR PID', formatHex(pmt.pcrPid, 4)],
            ['番組記述子', formatNumber(pmt.programInfo.length)],
          ]}
        />
        <DataTable
          columns={['PID', 'ストリーム種別', '記述子数']}
          rows={pmt.streams.map((stream) => [
            formatHex(stream.pid, 4),
            streamTypeLabel(stream.streamType),
            formatNumber(stream.descriptors.length),
          ])}
        />
      </div>
    )
  }

  const renderSdt = () => {
    if (!sdt) return <div className={styles.empty}>SDT 未受信</div>
    return (
      <div className={styles.stack}>
        <MetaList
          items={[
            ['TSID', formatHex(sdt.transportStreamId, 4)],
            ['ONID', formatHex(sdt.originalNetworkId, 4)],
            ['バージョン', formatNumber(sdt.version)],
          ]}
        />
        <DataTable
          columns={['サービス ID', '種別', '事業者名', 'サービス名']}
          rows={sdt.services.map((service) => [
            formatHex(service.serviceId, 4),
            formatHex(service.serviceType),
            service.providerName,
            service.serviceName,
          ])}
        />
      </div>
    )
  }

  const renderEit = () => {
    if (!eit) return <div className={styles.empty}>EIT 未受信</div>
    return (
      <div className={styles.stack}>
        <MetaList
          items={[
            ['テーブル ID', formatHex(eit.tableId)],
            ['サービス ID', formatHex(eit.serviceId, 4)],
            ['TSID', formatHex(eit.transportStreamId, 4)],
            ['種別', eit.presentFollowing ? '現在/次' : eit.schedule ? '番組表' : '—'],
            ['バージョン', formatNumber(eit.version)],
          ]}
        />
        <DataTable
          columns={['イベント ID', '開始 (JST)', '長さ', '状態', 'タイトル']}
          rows={eit.events.map((event) => [
            formatHex(event.eventId, 4),
            formatJstDateTime(event.startTime),
            `${formatNumber(event.duration)} 秒`,
            event.running ? '放送中' : '—',
            event.title,
          ])}
        />
      </div>
    )
  }

  const renderNit = () => {
    if (!nit) return <div className={styles.empty}>NIT 未受信</div>
    return (
      <div className={styles.stack}>
        <MetaList
          items={[
            ['ネットワーク ID', formatHex(nit.networkId, 4)],
            ['ネットワーク名', nit.networkName ?? '—'],
            ['バージョン', formatNumber(nit.version)],
          ]}
        />
        <DataTable
          columns={['TSID', 'ONID', '記述子数']}
          rows={nit.transportStreams.map((stream) => [
            formatHex(stream.transportStreamId, 4),
            formatHex(stream.originalNetworkId, 4),
            formatNumber(stream.descriptors.length),
          ])}
        />
      </div>
    )
  }

  const renderTdt = () => {
    if (!tdt) return <div className={styles.empty}>TDT 未受信</div>
    return (
      <MetaList
        items={[
          ['日時 (JST)', formatJstDateTime(tdt.utc)],
          ['時刻 (JST)', formatJstTime(tdt.utc)],
        ]}
      />
    )
  }

  const renderTot = () => {
    if (!tot) return <div className={styles.empty}>TOT 未受信</div>
    const offset = tot.localTimeOffsetMinutes * (tot.localTimeOffsetPolarity === 1 ? -1 : 1)
    return (
      <MetaList
        items={[
          ['日時 (JST)', formatJstDateTime(tot.utc)],
          ['ローカル時刻オフセット', `${offset} 分`],
          ['記述子数', formatNumber(tot.descriptors.length)],
        ]}
      />
    )
  }

  return (
    <div className={styles.stack}>
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
      {tab === 'pat' && renderPat()}
      {tab === 'pmt' && renderPmt()}
      {tab === 'sdt' && renderSdt()}
      {tab === 'eit' && renderEit()}
      {tab === 'nit' && renderNit()}
      {tab === 'tdt' && renderTdt()}
      {tab === 'tot' && renderTot()}
    </div>
  )
}
