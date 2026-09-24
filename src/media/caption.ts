/**
 * Minimal ARIB STD-B24 caption support (要件定義書 27).
 *
 * The full B24 presentation model (DRCS, positioning, colours, timing) is not
 * implemented. This module extracts statement text from the caption PES so the
 * viewer can toggle captions and read them over the video.
 */
import { decodeAribText } from '../data/arib/decode'

const DATA_UNIT_MANAGEMENT = new Set([0x1f, 0x60])
const DATA_UNIT_STATEMENT = new Set([0x20, 0x61])
const DEFAULT_TTL_MS = 6000

export interface CaptionDataUnit {
  id: number
  data: Uint8Array
}

/** Split a caption PES payload (`data_identifier` + data units) into data units. */
export function parseCaptionDataUnits(payload: Uint8Array): CaptionDataUnit[] {
  const units: CaptionDataUnit[] = []
  let offset = payload.length > 0 && payload[0] === 0x00 ? 1 : 0
  while (offset + 2 <= payload.length) {
    const id = payload[offset]
    const size = payload[offset + 1]
    offset += 2
    if (offset + size > payload.length) break
    if (DATA_UNIT_MANAGEMENT.has(id) || DATA_UNIT_STATEMENT.has(id)) {
      units.push({ id, data: payload.slice(offset, offset + size) })
    }
    offset += size
  }
  return units
}

export function isStatementUnit(unit: CaptionDataUnit): boolean {
  return DATA_UNIT_STATEMENT.has(unit.id)
}

/** Drop C1 control bytes and CSI sequences so only GL/GR characters remain. */
export function filterCaptionText(bytes: Uint8Array): Uint8Array {
  const out: number[] = []
  let index = 0
  while (index < bytes.length) {
    const byte = bytes[index++]
    if (byte === 0x1b) {
      out.push(byte)
      continue
    }
    if (byte === 0x9b) {
      while (index < bytes.length && bytes[index] >= 0x30 && bytes[index] <= 0x3f) index++
      while (index < bytes.length && bytes[index] >= 0x20 && bytes[index] <= 0x2f) index++
      if (index < bytes.length && bytes[index] >= 0x40 && bytes[index] <= 0x7e) index++
      continue
    }
    if (byte >= 0x80 && byte <= 0x9f) continue
    out.push(byte)
  }
  return Uint8Array.from(out)
}

/** Decode a caption PES payload to display text, or null when it has no statement. */
export function decodeCaptionPayload(payload: Uint8Array): string | null {
  const statements = parseCaptionDataUnits(payload).filter(isStatementUnit)
  if (statements.length === 0) return null
  return statements
    .map((unit) => decodeAribText(filterCaptionText(unit.data)))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export interface CaptionRendererOptions {
  /** How long a statement stays on screen without a new one, in ms. */
  ttlMs?: number
}

const FONT_STACK = "'Hiragino Kaku Gothic ProN', Meiryo, system-ui, sans-serif"

/** Holds the latest caption text and paints it over the video frame. */
export class CaptionRenderer {
  private text = ''
  private expiresAt = 0
  private readonly ttlMs: number

  constructor(options: CaptionRendererOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  get current(): string {
    return this.text
  }

  set(text: string | null): void {
    if (!text) {
      this.clear()
      return
    }
    this.text = text
    this.expiresAt = Date.now() + this.ttlMs
  }

  update(payload: Uint8Array): void {
    const decoded = decodeCaptionPayload(payload)
    if (decoded !== null) this.set(decoded)
  }

  clear(): void {
    this.text = ''
    this.expiresAt = 0
  }

  draw(context: CanvasRenderingContext2D, width: number, height: number): void {
    if (!this.text) return
    if (Date.now() > this.expiresAt) {
      this.clear()
      return
    }

    const fontSize = Math.max(14, Math.round(height / 16))
    context.save()
    context.font = `600 ${fontSize}px ${FONT_STACK}`
    context.textAlign = 'center'
    context.textBaseline = 'bottom'
    context.lineJoin = 'round'

    const maxWidth = width * 0.9
    const lines: string[] = []
    for (const raw of this.text.split('\n')) {
      let line = ''
      for (const char of raw) {
        const candidate = line + char
        if (line && context.measureText(candidate).width > maxWidth) {
          lines.push(line)
          line = char
        } else {
          line = candidate
        }
      }
      lines.push(line)
    }

    const lineHeight = Math.round(fontSize * 1.3)
    const blockHeight = lineHeight * lines.length
    const bottom = Math.round(height - fontSize)
    const top = bottom - blockHeight
    context.fillStyle = 'rgb(0 0 0 / 62%)'
    context.fillRect(0, top - 6, width, blockHeight + fontSize * 0.4)

    context.fillStyle = '#ffffff'
    context.strokeStyle = 'rgb(0 0 0 / 90%)'
    context.lineWidth = Math.max(2, fontSize / 8)
    for (let i = 0; i < lines.length; i++) {
      const y = top + lineHeight * (i + 1)
      context.strokeText(lines[i], width / 2, y)
      context.fillText(lines[i], width / 2, y)
    }
    context.restore()
  }
}
