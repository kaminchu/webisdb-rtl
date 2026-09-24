import { describeStreamType } from '../../ts/TransportStream'

/** Render a byte buffer as an offset / hex / ASCII dump. */
export function formatHexDump(data: Uint8Array, bytesPerRow = 16): string {
  if (data.length === 0) return ''
  const rows: string[] = []
  for (let offset = 0; offset < data.length; offset += bytesPerRow) {
    const slice = data.subarray(offset, Math.min(offset + bytesPerRow, data.length))
    const hex: string[] = []
    let ascii = ''
    for (let index = 0; index < bytesPerRow; index++) {
      const byte = slice[index]
      if (byte === undefined) {
        hex.push('  ')
        ascii += ' '
      } else {
        hex.push(byte.toString(16).padStart(2, '0'))
        ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.'
      }
    }
    rows.push(`${offset.toString(16).padStart(4, '0')}  ${hex.join(' ')}  ${ascii}`)
  }
  return rows.join('\n')
}

export function streamTypeLabel(streamType: number | undefined): string {
  if (streamType === undefined) return '—'
  return `${describeStreamType(streamType)} (${formatHex(streamType)})`
}

export function formatHex(value: number, width = 2): string {
  if (!Number.isFinite(value)) return '—'
  return `0x${value.toString(16).padStart(width, '0')}`
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('ja-JP')
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function formatBitrate(bitsPerSecond: number | null | undefined): string {
  if (bitsPerSecond === null || bitsPerSecond === undefined || !Number.isFinite(bitsPerSecond)) {
    return '—'
  }
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`
  if (bitsPerSecond >= 1_000) return `${(bitsPerSecond / 1_000).toFixed(1)} kbps`
  return `${bitsPerSecond.toFixed(0)} bps`
}

export function formatDb(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)} dB`
}

export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)} %`
}

export function formatSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes} 分 ${rest.toFixed(0)} 秒`
}
