/** Browser download helpers for debug dumps (要件定義書 33). */

export function downloadBytes(
  filename: string,
  data: Uint8Array,
  type = 'application/octet-stream',
): void {
  const blob = new Blob([data as BlobPart], { type })
  downloadBlob(filename, blob)
}

export function downloadText(filename: string, text: string, type = 'application/json'): void {
  downloadBlob(filename, new Blob([text], { type }))
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function timestampSlug(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
}
