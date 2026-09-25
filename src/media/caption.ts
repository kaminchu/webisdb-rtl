/**
 * ARIB STD-B24 caption decoding and rendering (要件定義書 27).
 *
 * Implements the one-seg (Profile C) presentation model: the independent PES
 * data-group format, the caption/statement data units and the 8-bit control
 * characters used for positioning, colour, character size and underlining.
 * Characters are painted onto the video canvas with the standard CLUT colours.
 */
import type { AribControlToken, AribToken } from '../data/arib/decode'
import { tokenizeAribText } from '../data/arib/decode'

const DATA_IDENTIFIER_CAPTION = 0x80
const DATA_IDENTIFIER_SUPERIMPOSE = 0x81
const DATA_UNIT_HEADER = 5
const DATA_UNIT_STATEMENT = 0x20
const DATA_UNIT_DRCS = 0x30
const DATA_UNIT_COLOR_MAP = 0x34
const DATA_GROUP_MANAGEMENT = 0
const DEFAULT_TTL_MS = 0
const DRCS_GETA = '\u3013'
const COLOR_MAP_COUNT = 8
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** Profile C caption plane: ARIB STD-B24 Part 3, Chapter 4. */
const PLANE_WIDTH = 320
const PLANE_HEIGHT = 180
const CHAR_WIDTH = 18
const CHAR_HEIGHT = 18
const CHAR_H_SPACING = 2
const CHAR_V_SPACING = 6
const BOTTOM_MARGIN = 6

/** Profile 0..4 CLUT, `0xRRGGBBAA`. */
const CLUT: readonly (readonly number[])[] = [
  [
    0x000000ff, 0xff0000ff, 0x00ff00ff, 0xffff00ff, 0x0000ffff, 0xff00ffff, 0x00ffffff, 0xffffffff,
    0x00000000, 0xaa0000ff, 0x00aa00ff, 0xaaaa00ff, 0x0000aaff, 0xaa00aaff, 0x00aaaaff, 0xaaaaaaff,
  ],
  [
    0x000055ff, 0x005500ff, 0x005555ff, 0x0055aaff, 0x0055ffff, 0x00aa55ff, 0x00aaffff, 0x00ff55ff,
    0x00ffaaff, 0x550000ff, 0x550055ff, 0x5500aaff, 0x5500ffff, 0x555500ff, 0x555555ff, 0x5555aaff,
  ],
  [
    0x5555ffff, 0x55aa00ff, 0x55aa55ff, 0x55aaaaff, 0x55aaffff, 0x55ff00ff, 0x55ff55ff, 0x55ffaaff,
    0x55ffffff, 0xaa0055ff, 0xaa00ffff, 0xaa5500ff, 0xaa5555ff, 0xaa55aaff, 0xaa55ffff, 0xaaaa55ff,
  ],
  [
    0xaaaaffff, 0xaaff00ff, 0xaaff55ff, 0xaaffaaff, 0xaaffffff, 0xff0055ff, 0xff00aaff, 0xff5500ff,
    0xff5555ff, 0xff55aaff, 0xff55ffff, 0xffaa00ff, 0xffaa55ff, 0xffaaaaff, 0xffaaffff, 0xffff55ff,
  ],
  [
    0xffffaaff, 0x00000080, 0xff000080, 0x00ff0080, 0xffff0080, 0x0000ff80, 0xff00ff80, 0x00ffff80,
    0xffffff80, 0xaa000080, 0x00aa0080, 0xaaaa0080, 0x0000aa80, 0xaa00aa80, 0x00aaaa80, 0xaaaaaa80,
  ],
]

export interface CaptionColor {
  r: number
  g: number
  b: number
  a: number
}

/** A decoded DRCS bitmap glyph. */
export interface DrcsGlyph {
  width: number
  height: number
  bitsPerPixel: number
  pattern: Uint8Array
}

function clut(palette: number, index: number): CaptionColor {
  const entries = CLUT[Math.min(palette, CLUT.length - 1)] ?? CLUT[0]
  const value = entries[index & 0x0f] ?? 0
  return {
    r: (value >>> 24) & 0xff,
    g: (value >>> 16) & 0xff,
    b: (value >>> 8) & 0xff,
    a: value & 0xff,
  }
}

function colorToCss(color: CaptionColor): string {
  return `rgba(${color.r},${color.g},${color.b},${(color.a / 255).toFixed(3)})`
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

/** Convert a studio-swing Y/Cb/Cr colour (ARIB STD-B24 Part 3, 7.2) to RGB. */
function ycbcrToColor(y: number, cb: number, cr: number, a: number): CaptionColor {
  const luma = ((y - 16) * 255) / 219
  const blue = ((cb - 128) * 255) / 224
  const red = ((cr - 128) * 255) / 224
  return {
    r: clampByte(luma + 1.402 * red),
    g: clampByte(luma - 0.344136 * blue - 0.714136 * red),
    b: clampByte(luma + 1.772 * blue),
    a,
  }
}

/** Read nine BCD nibbles (hour, minute, second, millisecond) into milliseconds. */
function bcdNibble(value: number): number {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f)
}

function bcdTimeToMs(bytes: Uint8Array, offset: number): number {
  const hours = bcdNibble(bytes[offset] ?? 0)
  const minutes = bcdNibble(bytes[offset + 1] ?? 0)
  const seconds = bcdNibble(bytes[offset + 2] ?? 0)
  const milliseconds = bcdNibble(bytes[offset + 3] ?? 0) * 10 + ((bytes[offset + 4] ?? 0) >> 4)
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds
}

/** Milliseconds since midnight in JST. */
function jstMillisOfDay(now: number): number {
  const shifted = new Date(now + JST_OFFSET_MS)
  return (
    ((shifted.getUTCHours() * 60 + shifted.getUTCMinutes()) * 60 + shifted.getUTCSeconds()) * 1000 +
    shifted.getUTCMilliseconds()
  )
}

/** Map a JST time of day to the nearest epoch timestamp around `now`. */
function timeOfDayToEpoch(msOfDay: number, now: number): number {
  const day = 24 * 60 * 60 * 1000
  let delta = (((msOfDay - jstMillisOfDay(now)) % day) + day) % day
  if (delta > day / 2) delta -= day
  return now + delta
}

export interface CaptionChar {
  text: string
  /** Top-left position in caption-plane pixels. */
  x: number
  y: number
  width: number
  height: number
  foreground: CaptionColor
  background: CaptionColor
  underline: boolean
  bold: boolean
  italic: boolean
  flashing: boolean
  stroke: CaptionColor | null
  /** Set when the character is a DRCS bitmap rather than text. */
  drcs?: DrcsGlyph
}

export interface CaptionFrame {
  width: number
  height: number
  chars: CaptionChar[]
  hasExplicitPosition: boolean
  /** PES PTS of the statement in 90 kHz units; null when the source has none. */
  startPts90k: number | null
  /** Wall-clock presentation time from STM (asynchronous PES); null otherwise. */
  startWallMs: number | null
  /** Downloaded colour map entries (Y/Cb/Cr converted) indexed by address. */
  colorMap: (CaptionColor | null)[] | null
}

interface DataUnit {
  parameter: number
  data: Uint8Array
}

interface DataGroup {
  id: number
  data: Uint8Array
}

function readUint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]
}

/** Split an independent PES payload into its data groups (or data units). */
function parseDataGroups(payload: Uint8Array): DataGroup[] {
  if (payload.length < 3) return []
  const identifier = payload[0]
  if (identifier !== DATA_IDENTIFIER_CAPTION && identifier !== DATA_IDENTIFIER_SUPERIMPOSE) {
    return parseLegacyDataUnits(payload)
  }
  const headerLength = payload[2] & 0x0f
  let offset = 3 + headerLength
  const groups: DataGroup[] = []
  while (offset + 5 <= payload.length) {
    const id = payload[offset] >> 2
    const size = (payload[offset + 3] << 8) | payload[offset + 4]
    offset += 5
    if (size === 0 || offset + size > payload.length) break
    groups.push({ id, data: payload.subarray(offset, offset + size) })
    offset += size + 2
  }
  return groups
}

/** Older `data_identifier == 0x00` data-unit format used by some streams. */
function parseLegacyDataUnits(payload: Uint8Array): DataGroup[] {
  if (payload[0] !== 0x00) return []
  let offset = 1
  const groups: DataGroup[] = []
  while (offset + 2 <= payload.length) {
    const id = payload[offset]
    const size = payload[offset + 1]
    offset += 2
    if (offset + size > payload.length) break
    groups.push({
      id: id === 0x1f ? DATA_GROUP_MANAGEMENT : 1,
      data: payload.subarray(offset, offset + size),
    })
    offset += size
  }
  return groups
}

function parseDataUnits(data: Uint8Array, offset: number, length: number): DataUnit[] {
  const end = Math.min(offset + length, data.length)
  const units: DataUnit[] = []
  while (offset + DATA_UNIT_HEADER <= end) {
    const parameter = data[offset + 1]
    const size = readUint24(data, offset + 2)
    offset += DATA_UNIT_HEADER
    if (size === 0 || offset + size > end) break
    if (
      parameter === DATA_UNIT_STATEMENT ||
      parameter === DATA_UNIT_DRCS ||
      parameter === DATA_UNIT_DRCS + 1 ||
      parameter === DATA_UNIT_COLOR_MAP
    ) {
      units.push({ parameter, data: data.subarray(offset, offset + size) })
    }
    offset += size
  }
  return units
}

function skipLanguages(data: Uint8Array, offset: number): number {
  const count = data[offset] ?? 0
  offset += 1
  for (let i = 0; i < count; i++) {
    if (offset >= data.length) return offset
    const dmf = data[offset] & 0x0f
    offset += 1
    if (dmf === 0x0c || dmf === 0x0d || dmf === 0x0e) offset += 1
    offset += 4
  }
  return offset
}

class CaptionDecoder {
  private readonly chars: CaptionChar[] = []
  private readonly drcs = new Map<number, DrcsGlyph>()
  private readonly colorMaps: Map<number, CaptionColor>[] = Array.from(
    { length: COLOR_MAP_COUNT },
    () => new Map<number, CaptionColor>(),
  )
  private readonly planeWidth = PLANE_WIDTH
  private readonly planeHeight = PLANE_HEIGHT
  private readonly clock: () => number
  private palette = 0
  private textColor = clut(0, 7)
  private backColor = clut(0, 8)
  private strokeColor: CaptionColor | null = null
  private underline = false
  private bold = false
  private italic = false
  private flashing = false
  private displayStartX = 0
  private displayStartY = 0
  private displayWidth = PLANE_WIDTH
  private displayHeight = PLANE_HEIGHT
  private charWidth = CHAR_WIDTH
  private charHeight = CHAR_HEIGHT
  private hSpacing = CHAR_H_SPACING
  private vSpacing = CHAR_V_SPACING
  private hScale = 1
  private vScale = 1
  private activeX = 0
  private activeY = 0
  private activeInited = false
  private hasExplicitPosition = false
  private produced = false
  private tmd = 0
  private stmMs: number | null = null
  private otmMs = 0

  constructor(clock: () => number = Date.now) {
    this.clock = clock
  }

  private color(palette: number, index: number): CaptionColor {
    const custom = this.colorMaps[palette & 0x07]?.get(index & 0xff)
    return custom ?? clut(palette, index)
  }

  private snapshotColorMap(): (CaptionColor | null)[] | null {
    const entries = this.colorMaps[this.palette & 0x07]
    if (!entries || entries.size === 0) return null
    const snapshot: (CaptionColor | null)[] = Array.from({ length: 256 }, () => null)
    for (const [address, color] of entries) snapshot[address] = color
    return snapshot
  }

  frame(): CaptionFrame {
    return {
      width: this.planeWidth,
      height: this.planeHeight,
      chars: [...this.chars],
      hasExplicitPosition: this.hasExplicitPosition,
      startPts90k: null,
      startWallMs: null,
      colorMap: this.snapshotColorMap(),
    }
  }

  /** Resolve the display schedule from the PES PTS, or from STM for async PES. */
  private schedule(frame: CaptionFrame, pts90k: number | null): void {
    if (pts90k !== null) {
      frame.startPts90k = pts90k + (this.tmd === 0b10 ? this.otmMs * 90 : 0)
      return
    }
    if (this.tmd !== 0 && this.stmMs !== null) {
      const offset = this.tmd === 0b10 ? this.otmMs : 0
      frame.startWallMs = timeOfDayToEpoch(this.stmMs + offset, this.clock())
    }
  }

  /**
   * Decode one full caption PES payload. DRCS definitions and downloaded colour
   * maps are retained between calls so later statements can reference them.
   */
  decode(payload: Uint8Array, pts90k: number | null = null): CaptionFrame | null {
    const groups = parseDataGroups(payload)
    if (groups.length === 0) return null
    this.clearScreen()
    this.produced = false
    this.tmd = 0
    this.stmMs = null
    for (const group of groups) {
      if ((group.id & 0x0f) === DATA_GROUP_MANAGEMENT) this.applyManagement(group.data)
    }
    let statement = groups.find((group) => (group.id & 0x0f) === 1)
    if (!statement) statement = groups.find((group) => (group.id & 0x0f) !== 0)
    if (statement && !this.applyStatement(statement.data)) return null
    if (!this.produced) return null
    const frame = this.frame()
    this.schedule(frame, pts90k)
    return frame
  }

  applyManagement(data: Uint8Array): void {
    if (data.length < 2) return
    let offset = 1
    if (data[0] >> 6 === 0b10) {
      this.otmMs = bcdTimeToMs(data, 1)
      offset += 5
    }
    offset = skipLanguages(data, offset)
    if (offset + 3 > data.length) return
    const length = readUint24(data, offset)
    for (const unit of parseDataUnits(data, offset + 3, length)) this.applyDataUnit(unit)
  }

  applyStatement(data: Uint8Array): boolean {
    if (data.length < 4) return false
    let offset = 1
    const tmd = data[0] >> 6
    if (tmd === 0b01 || tmd === 0b10) {
      this.tmd = tmd
      this.stmMs = bcdTimeToMs(data, 1)
      offset += 5
    }
    if (offset + 3 > data.length) return false
    const length = readUint24(data, offset)
    for (const unit of parseDataUnits(data, offset + 3, length)) this.applyDataUnit(unit)
    return true
  }

  private applyDataUnit(unit: DataUnit): void {
    if (unit.parameter === DATA_UNIT_STATEMENT) {
      this.produced = true
      const options = { graphics: [0xc1, 0x4a, 0x42, 0x20] as const, gl: 0, gr: 2 }
      for (const token of tokenizeAribText(unit.data, options)) this.applyToken(token)
    } else if (unit.parameter === DATA_UNIT_DRCS) {
      this.registerDrcs(unit.data, 1)
    } else if (unit.parameter === DATA_UNIT_DRCS + 1) {
      this.registerDrcs(unit.data, 2)
    } else if (unit.parameter === DATA_UNIT_COLOR_MAP) {
      this.registerColorMap(unit.data)
    }
  }

  /** ARIB STD-B24 Part 3, 7.2: colour map data unit. */
  private registerColorMap(data: Uint8Array): void {
    if (data.length < 5) return
    const entries = this.colorMaps[this.palette & 0x07]
    if (!entries) return
    let address = data[4]!
    entries.set(address, ycbcrToColor(data[0]!, data[1]!, data[2]!, data[3]!))
    let offset = 5
    while (offset + 4 <= data.length) {
      address = (address + 1) & 0xff
      entries.set(
        address,
        ycbcrToColor(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!),
      )
      offset += 4
    }
  }

  /** ARIB STD-B24 Annex D: DRCS pattern data. */
  private registerDrcs(data: Uint8Array, byteCount: number): void {
    let offset = 0
    const codes = data[offset++] ?? 0
    for (let i = 0; i < codes; i++) {
      if (offset + 3 > data.length) return
      const characterCode = (data[offset]! << 8) | data[offset + 1]!
      const fonts = data[offset + 2]!
      offset += 3
      for (let j = 0; j < fonts; j++) {
        if (offset + 1 > data.length) return
        const mode = data[offset]! & 0x0f
        offset += 1
        if (mode === 0 || mode === 1) {
          if (offset + 3 > data.length) return
          const depth = (data[offset] ?? 0) + 2
          const width = data[offset + 1] ?? 0
          const height = data[offset + 2] ?? 0
          offset += 3
          const bitsPerPixel = Math.max(1, Math.ceil(Math.log2(depth)))
          const size = Math.ceil((width * height * bitsPerPixel) / 8)
          if (width === 0 || height === 0 || offset + size > data.length) return
          const pattern = data.slice(offset, offset + size)
          offset += size
          const key =
            byteCount === 1
              ? (((characterCode >> 8) - 0x40) << 16) | (characterCode & 0xff & 0x7f)
              : characterCode >= 0xec00 && characterCode <= 0xf8ff
                ? characterCode
                : characterCode & 0x7f7f
          this.drcs.set(key, { width, height, bitsPerPixel, pattern })
        } else {
          if (offset + 4 > data.length) return
          const length = ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0)
          offset += 4 + length
        }
      }
    }
  }

  private clearScreen(): void {
    this.chars.length = 0
    this.palette = 0
    this.textColor = this.color(0, 7)
    this.backColor = this.color(0, 8)
    this.strokeColor = null
    this.underline = false
    this.bold = false
    this.italic = false
    this.flashing = false
    this.displayStartX = 0
    this.displayStartY = 0
    this.displayWidth = this.planeWidth
    this.displayHeight = this.planeHeight
    this.charWidth = CHAR_WIDTH
    this.charHeight = CHAR_HEIGHT
    this.hSpacing = CHAR_H_SPACING
    this.vSpacing = CHAR_V_SPACING
    this.hScale = 1
    this.vScale = 1
    this.activeX = 0
    this.activeY = 0
    this.activeInited = false
    this.hasExplicitPosition = false
  }

  private sectionWidth(): number {
    return Math.floor((this.charWidth + this.hSpacing) * this.hScale)
  }

  private sectionHeight(): number {
    return Math.floor((this.charHeight + this.vSpacing) * this.vScale)
  }

  private setActiveCell(column: number, row: number): void {
    this.activeInited = true
    this.activeX = this.displayStartX + column * this.sectionWidth()
    this.activeY = this.displayStartY + (row + 1) * this.sectionHeight()
  }

  private setActiveDot(x: number, y: number): void {
    this.activeInited = true
    this.activeX = x
    this.activeY = y
  }

  private move(dx: number, dy: number): void {
    if (!this.activeInited) this.setActiveCell(0, 0)
    let x = dx
    let y = dy
    while (x < 0) {
      this.activeX -= this.sectionWidth()
      x++
      if (this.activeX < this.displayStartX) {
        this.activeX = this.displayStartX + this.displayWidth - this.sectionWidth()
        y--
      }
    }
    while (x > 0) {
      this.activeX += this.sectionWidth()
      x--
      if (this.activeX >= this.displayStartX + this.displayWidth) {
        this.activeX = this.displayStartX
        y++
      }
    }
    while (y < 0) {
      this.activeY -= this.sectionHeight()
      y++
      if (this.activeY < this.displayStartY) this.activeY = this.displayStartY + this.displayHeight
    }
    while (y > 0) {
      this.activeY += this.sectionHeight()
      y--
      if (this.activeY > this.displayStartY + this.displayHeight) {
        this.activeY = this.displayStartY + this.sectionHeight()
      }
    }
  }

  private newline(): void {
    if (!this.activeInited) this.setActiveCell(0, 0)
    this.activeX = this.displayStartX
    this.activeY += this.sectionHeight()
  }

  private pushChar(text: string, drcs?: DrcsGlyph): void {
    if (!this.activeInited) this.setActiveCell(0, 0)
    this.chars.push({
      text,
      x: this.activeX,
      y: this.activeY - this.sectionHeight(),
      width: Math.round(this.charWidth * this.hScale),
      height: Math.round(this.charHeight * this.vScale),
      foreground: this.textColor,
      background: this.backColor,
      underline: this.underline,
      bold: this.bold,
      italic: this.italic,
      flashing: this.flashing,
      stroke: this.strokeColor,
      ...(drcs ? { drcs } : {}),
    })
  }

  private applyToken(token: AribToken): void {
    if (token.type === 'char') {
      this.pushChar(token.text)
      this.move(1, 0)
      return
    }
    if (token.type === 'drcs') {
      const glyph = this.drcs.get(((token.map & 0x0f) << 16) | token.code)
      this.pushChar(glyph ? '' : DRCS_GETA, glyph)
      this.move(1, 0)
      return
    }
    if (token.code === 0x9b) this.applyCsi(token)
    else if (token.code < 0x20) this.applyC0(token)
    else this.applyC1(token)
  }

  private applyC0(token: AribControlToken): void {
    switch (token.code) {
      case 0x08:
        this.move(-1, 0)
        break
      case 0x09:
        this.move(1, 0)
        break
      case 0x0a:
        this.move(0, 1)
        break
      case 0x0b:
        this.move(0, -1)
        break
      case 0x0c:
        this.clearScreen()
        break
      case 0x0d:
        this.newline()
        break
      case 0x16:
        this.move(token.params[0]! & 0x3f, 0)
        break
      case 0x1c:
        this.hasExplicitPosition = true
        this.setActiveCell(token.params[1]! & 0x3f, token.params[0]! & 0x3f)
        break
      default:
        break
    }
  }

  private applyC1(token: AribControlToken): void {
    const operand = token.params[0] ?? 0
    switch (token.code) {
      case 0x80:
      case 0x81:
      case 0x82:
      case 0x83:
      case 0x84:
      case 0x85:
      case 0x86:
      case 0x87:
        this.textColor = this.color(this.palette, token.code - 0x80)
        break
      case 0x88:
        this.hScale = 0.5
        this.vScale = 0.5
        break
      case 0x89:
        this.hScale = 0.5
        this.vScale = 1
        break
      case 0x8a:
        this.hScale = 1
        this.vScale = 1
        break
      case 0x8b:
        if (operand === 0x41) this.vScale = 2
        else if (operand === 0x44) this.hScale = 2
        else if (operand === 0x45) {
          this.hScale = 2
          this.vScale = 2
        }
        break
      case 0x90:
        if (operand === 0x20) this.palette = (token.params[1] ?? 0) & 0x07
        else if ((operand & 0xf0) === 0x40) {
          this.textColor = this.color(this.palette, operand & 0x0f)
        } else if ((operand & 0xf0) === 0x50) {
          this.backColor = this.color(this.palette, operand & 0x0f)
        }
        break
      case 0x91:
        this.flashing = (operand & 0x0f) !== 0
        break
      case 0x97:
        break
      case 0x99:
        this.underline = false
        break
      case 0x9a:
        this.underline = true
        break
      case 0x9d:
        break
      default:
        break
    }
  }

  private applyCsi(token: AribControlToken): void {
    const params = token.params
    switch (token.final) {
      case 0x56:
        this.displayWidth = params[0] ?? this.displayWidth
        this.displayHeight = params[1] ?? this.displayHeight
        break
      case 0x57:
        this.charWidth = params[0] ?? this.charWidth
        this.charHeight = params[1] ?? this.charHeight
        break
      case 0x58:
        this.hSpacing = params[0] ?? this.hSpacing
        break
      case 0x59:
        this.vSpacing = params[0] ?? this.vSpacing
        break
      case 0x5f:
        this.displayStartX = params[0] ?? 0
        if (params.length >= 2) this.displayStartY = params[1]!
        if (this.displayStartX !== 0 || this.displayStartY !== 0) this.hasExplicitPosition = true
        if (!this.activeInited) this.setActiveCell(0, 0)
        break
      case 0x61:
        this.hasExplicitPosition = true
        this.setActiveDot(params[0] ?? 0, params[1] ?? 0)
        break
      case 0x63:
        if (params[0] === 0) this.strokeColor = null
        else if (params[0] === 1 && params.length >= 2) {
          const value = params[1]!
          this.strokeColor = this.color(Math.floor(value / 100), value % 100)
        }
        break
      case 0x64:
        this.bold = params[0] === 1 || params[0] === 3
        this.italic = params[0] === 2 || params[0] === 3
        break
      default:
        break
    }
  }
}

/** Decode one caption PES payload into a renderable frame, or null when absent. */
export function decodeCaptionPayload(
  payload: Uint8Array,
  pts90k: number | null = null,
  clock: () => number = Date.now,
): CaptionFrame | null {
  return new CaptionDecoder(clock).decode(payload, pts90k)
}

export interface CaptionRendererOptions {
  /** How long a statement stays on screen without a new one, in ms. 0 disables. */
  ttlMs?: number
  /** Wall clock in milliseconds; overridable for tests. */
  clock?: () => number
}

const FONT_STACK = "'Hiragino Kaku Gothic ProN', Meiryo, system-ui, sans-serif"

function drcsPixel(glyph: DrcsGlyph, x: number, y: number): number {
  const start = (y * glyph.width + x) * glyph.bitsPerPixel
  let value = 0
  for (let bit = 0; bit < glyph.bitsPerPixel; bit++) {
    const absolute = start + bit
    const byte = glyph.pattern[absolute >> 3] ?? 0
    value = (value << 1) | ((byte >> (7 - (absolute & 7))) & 1)
  }
  return value
}

function drawDrcs(
  context: CanvasRenderingContext2D,
  glyph: DrcsGlyph,
  foreground: CaptionColor,
  colorMap: (CaptionColor | null)[] | null,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const maxValue = (1 << glyph.bitsPerPixel) - 1
  const colorFor = (value: number): CaptionColor => {
    const mapped = colorMap?.[value]
    if (mapped) return mapped
    if (glyph.bitsPerPixel <= 1 || maxValue === 0) return foreground
    const alpha = Math.round((255 * value) / maxValue)
    return { ...foreground, a: Math.round((foreground.a * alpha) / 255) }
  }
  const cellWidth = width / glyph.width
  const cellHeight = height / glyph.height
  for (let row = 0; row < glyph.height; row++) {
    let start = 0
    let value = glyph.width > 0 ? drcsPixel(glyph, 0, row) : 0
    for (let column = 1; column <= glyph.width; column++) {
      const next = column < glyph.width ? drcsPixel(glyph, column, row) : 0
      if (next !== value) {
        if (value > 0) {
          context.fillStyle = colorToCss(colorFor(value))
          context.fillRect(
            x + start * cellWidth,
            y + row * cellHeight,
            (column - start) * cellWidth,
            cellHeight,
          )
        }
        start = column
        value = next
      }
    }
  }
}

/** Holds the latest caption frame and paints it over the video. */
export class CaptionRenderer {
  private readonly decoder: CaptionDecoder
  private readonly clock: () => number
  private active: CaptionFrame | null = null
  private pending: CaptionFrame[] = []
  private expiresAt = 0
  private readonly ttlMs: number

  constructor(options: CaptionRendererOptions = {}) {
    this.clock = options.clock ?? Date.now
    this.decoder = new CaptionDecoder(this.clock)
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  }

  get current(): CaptionFrame | null {
    return this.active
  }

  set(frame: CaptionFrame | null): void {
    this.pending = []
    if (!frame) {
      this.active = null
      this.expiresAt = 0
      return
    }
    this.active = frame
    this.expiresAt = this.ttlMs > 0 ? this.clock() + this.ttlMs : 0
  }

  update(payload: Uint8Array, pts90k?: number): void {
    const decoded = this.decoder.decode(payload, pts90k ?? null)
    if (!decoded) return
    if (decoded.startPts90k === null && decoded.startWallMs === null) {
      this.set(decoded)
      return
    }
    const activePts = this.active?.startPts90k ?? null
    if (decoded.startPts90k !== null && activePts !== null && decoded.startPts90k <= activePts) {
      return
    }
    const activeWall = this.active?.startWallMs ?? null
    if (decoded.startWallMs !== null && activeWall !== null && decoded.startWallMs <= activeWall) {
      return
    }
    this.pending.push(decoded)
  }

  clear(): void {
    this.pending = []
    this.active = null
    this.expiresAt = 0
  }

  private isDue(frame: CaptionFrame, currentPts90k: number | null, now: number): boolean {
    if (frame.startPts90k !== null) {
      return currentPts90k === null || frame.startPts90k <= currentPts90k
    }
    if (frame.startWallMs !== null) return frame.startWallMs <= now
    return true
  }

  /** Advance to the newest statement whose scheduled time has been reached. */
  private sync(currentPts90k: number | null): void {
    const now = this.clock()
    while (this.pending.length > 0 && this.isDue(this.pending[0]!, currentPts90k, now)) {
      this.active = this.pending.shift()!
      if (this.ttlMs > 0) this.expiresAt = now + this.ttlMs
    }
  }

  draw(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    currentPts90k?: number,
  ): void {
    this.sync(currentPts90k ?? null)
    const frame = this.active
    if (!frame) return
    if (this.ttlMs > 0 && this.clock() > this.expiresAt) {
      this.clear()
      return
    }

    const scaleX = width / frame.width
    const scaleY = height / frame.height
    // One-seg standards omit positioning for normal subtitles; anchor the block to the bottom.
    const bottom = frame.chars.reduce((max, char) => Math.max(max, char.y + char.height), 0)
    const offsetY = frame.hasExplicitPosition
      ? 0
      : Math.max(0, frame.height - BOTTOM_MARGIN - bottom)
    const now = this.clock()
    context.save()
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.lineJoin = 'round'

    for (const char of frame.chars) {
      if (char.flashing && Math.floor(now / 500) % 2 === 1) continue
      const x = char.x * scaleX
      const y = (char.y + offsetY) * scaleY
      const w = char.width * scaleX
      const h = char.height * scaleY
      if (char.background.a > 0) {
        context.fillStyle = colorToCss(char.background)
        context.fillRect(x, y, w, h)
      }
      if (char.drcs) {
        drawDrcs(context, char.drcs, char.foreground, frame.colorMap, x, y, w, h)
      } else {
        const fontSize = Math.max(8, Math.round(h * 0.92))
        const style = char.italic ? 'italic ' : ''
        const weight = char.bold ? '700' : '400'
        context.font = `${style}${weight} ${fontSize}px ${FONT_STACK}`
        const cx = x + w / 2
        const cy = y + h / 2
        context.lineWidth = Math.max(1, h / 9)
        if (char.stroke) {
          context.strokeStyle = colorToCss(char.stroke)
          context.strokeText(char.text, cx, cy)
        } else if (char.background.a === 0) {
          context.strokeStyle = 'rgba(0,0,0,0.85)'
          context.strokeText(char.text, cx, cy)
        }
        context.fillStyle = colorToCss(char.foreground)
        context.fillText(char.text, cx, cy)
      }
      if (char.underline) {
        context.strokeStyle = colorToCss(char.foreground)
        context.lineWidth = Math.max(1, h / 12)
        context.beginPath()
        context.moveTo(x, y + h * 0.94)
        context.lineTo(x + w, y + h * 0.94)
        context.stroke()
      }
    }
    context.restore()
  }
}
