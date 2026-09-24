import { formatHexDump } from './format'
import styles from './DebugPanels.module.css'

export interface RawHexViewProps {
  data: Uint8Array | null | undefined
  title?: string
  bytesPerRow?: number
  maxBytes?: number
}

export function RawHexView({ data, title, bytesPerRow = 16, maxBytes = 2048 }: RawHexViewProps) {
  if (!data || data.length === 0) return null
  const visible = data.length > maxBytes ? data.subarray(0, maxBytes) : data
  return (
    <div className={styles.hexBlock}>
      {title && <div className={styles.hexTitle}>{title}</div>}
      <pre className={styles.hex}>{formatHexDump(visible, bytesPerRow)}</pre>
      {data.length > maxBytes && (
        <div className={styles.hexNote}>
          先頭 {maxBytes} バイトのみ表示（全 {data.length} バイト）
        </div>
      )}
    </div>
  )
}
