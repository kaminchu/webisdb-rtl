import { ARIB_ADDITIONAL_SYMBOLS } from './gaiji'

const REPLACEMENT = '\ufffd'

const FALLBACK_GR: Record<number, string> = {
  0xa3ce: 'Ｎ',
  0xa3c8: 'Ｈ',
  0xa3cb: 'Ｋ',
  0xc1ed: '総',
  0xb9e7: '合',
  0xa4b3: 'こ',
  0xa4f3: 'ん',
  0xa4cb: 'に',
  0xa4c1: 'ち',
  0xa4cf: 'は',
  0xa5c6: 'テ',
  0xa5b9: 'ス',
  0xa5c8: 'ト',
}

let decoder: TextDecoder | null | undefined

function getDecoder(): TextDecoder | null {
  if (decoder === undefined) {
    try {
      decoder = new TextDecoder('euc-jp')
    } catch {
      decoder = null
    }
  }
  return decoder
}

/** Decode JIS X 0208 or an ARIB additional symbol from EUC-JP bytes. */
function decodeEuc(bytes: number[]): string {
  if (bytes.length === 0) return ''
  if (
    bytes.length === 2 &&
    bytes[0] >= 0xf5 &&
    bytes[0] <= 0xfe &&
    bytes[1] >= 0xa1 &&
    bytes[1] <= 0xfe
  ) {
    const row = bytes[0] - 0xa1
    const cell = bytes[1] - 0xa1
    const symbol = ARIB_ADDITIONAL_SYMBOLS.get((row - 84) * 94 + cell)
    if (symbol !== undefined) return String.fromCodePoint(symbol)
    return REPLACEMENT
  }
  const active = getDecoder()
  if (active) return active.decode(Uint8Array.from(bytes))
  let result = ''
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte < 0x80) {
      result += String.fromCharCode(byte)
    } else if (i + 1 < bytes.length && bytes[i + 1] >= 0xa1) {
      result += FALLBACK_GR[(byte << 8) | bytes[i + 1]] ?? REPLACEMENT
      i++
    } else {
      result += REPLACEMENT
    }
  }
  return result
}

/** ARIB STD-B24 single-byte Hiragana/Katakana sets share this punctuation tail. */
const KATAKANA_PUNCTUATION = [0x30fd, 0x30fe, 0x30fc, 0x3002, 0x300c, 0x300d, 0x3001, 0x30fb]
const HIRAGANA_PUNCTUATION = [0x309d, 0x309e]

function decodeKatakana(code: number): string {
  if (code <= 0x76) return String.fromCodePoint(0x3080 + code)
  const punctuation = KATAKANA_PUNCTUATION[code - 0x77]
  return punctuation === undefined ? REPLACEMENT : String.fromCodePoint(punctuation)
}

function decodeHiragana(code: number): string {
  if (code <= 0x73) return String.fromCodePoint(0x3020 + code)
  if (code === 0x77 || code === 0x78) return String.fromCodePoint(HIRAGANA_PUNCTUATION[code - 0x77])
  const punctuation = KATAKANA_PUNCTUATION[code - 0x77]
  return punctuation === undefined ? REPLACEMENT : String.fromCodePoint(punctuation)
}

export interface AribCharToken {
  type: 'char'
  text: string
}

export interface AribControlToken {
  type: 'control'
  /** C0/C1 control byte, or 0x9b for a CSI sequence. */
  code: number
  /** Operands of a C1 command, or the numeric parameters of a CSI sequence. */
  params: number[]
  /** Final byte of a CSI sequence. */
  final?: number
}

export interface AribDrcsToken {
  type: 'drcs'
  /** DRCS set index (0-15). */
  map: number
  /** Character code within the DRCS set. */
  code: number
}

export type AribToken = AribCharToken | AribControlToken | AribDrcsToken

export interface AribDecodeOptions {
  /** Initial G0..G3 designations; defaults to the SI text arrangement. */
  graphics?: readonly number[]
  /** Initial GL assignment (0 or 1). */
  gl?: number
  /** Initial GR assignment (2 or 3). */
  gr?: number
}

function control(code: number, params: number[] = [], final?: number): AribControlToken {
  return final === undefined
    ? { type: 'control', code, params }
    : { type: 'control', code, params, final }
}

function readCsi(bytes: Uint8Array, start: number): { token: AribControlToken; index: number } {
  const params: number[] = []
  let current = 0
  let hasValue = false
  let i = start
  while (i < bytes.length) {
    const byte = bytes[i]
    if (byte >= 0x30 && byte <= 0x39) {
      current = current * 10 + (byte - 0x30)
      hasValue = true
      i++
    } else if (byte === 0x3b) {
      params.push(hasValue ? current : 0)
      current = 0
      hasValue = false
      i++
    } else if (byte >= 0x20 && byte <= 0x2f) {
      i++
    } else if (byte >= 0x40 && byte <= 0x7e) {
      params.push(hasValue ? current : 0)
      return { token: control(0x9b, params, byte), index: i + 1 }
    } else {
      break
    }
  }
  return { token: control(0x9b, params), index: i }
}

function readC1(
  code: number,
  bytes: Uint8Array,
  start: number,
): { token: AribControlToken; index: number } {
  switch (code) {
    case 0x9b:
      return readCsi(bytes, start)
    case 0x95: {
      const parsed = readCsi(bytes, start)
      return { token: control(code, parsed.token.params, parsed.token.final), index: parsed.index }
    }
    case 0x90:
    case 0x92:
    case 0x9d:
      if (bytes[start] === 0x20) {
        return { token: control(code, [0x20, bytes[start + 1] ?? 0]), index: start + 2 }
      }
      return { token: control(code, [bytes[start] ?? 0]), index: start + 1 }
    case 0x8b:
    case 0x91:
    case 0x93:
    case 0x94:
    case 0x97:
    case 0x98:
      return { token: control(code, [bytes[start] ?? 0]), index: start + 1 }
    default:
      return { token: control(code), index: start }
  }
}

/**
 * Tokenize an ARIB STD-B24 8-bit character stream into graphic characters and
 * control functions. Designations (ESC) and locking/single shifts are applied
 * internally; C0/C1/CSI sequences are returned as tokens for the caller.
 */
export function tokenizeAribText(bytes: Uint8Array, options: AribDecodeOptions = {}): AribToken[] {
  const tokens: AribToken[] = []
  const sets = options.graphics ? [...options.graphics] : [0x42, 0x4a, 0x30, 0x31]
  let gl = options.gl ?? 0
  let gr = options.gr ?? 2
  let single: number | null = null
  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i++]
    if (byte === 0x1b) {
      const next = bytes[i]
      if (next === 0x5b) {
        i++
        const parsed = readCsi(bytes, i)
        tokens.push(parsed.token)
        i = parsed.index
        continue
      }
      i++
      if (next === 0x6e || next === 0x6f) gl = next - 0x6c
      else if (next >= 0x7c && next <= 0x7e) gr = 0x7f - next
      else {
        let slot = next
        if (next === 0x24) slot = bytes[i] >= 0x28 && bytes[i] <= 0x2b ? bytes[i++] : 0x28
        if (slot >= 0x28 && slot <= 0x2b) {
          if (bytes[i] === 0x20) {
            const drcs = bytes[i + 1] ?? 0
            sets[slot - 0x28] = drcs >= 0x40 && drcs <= 0x4f ? drcs | 0x80 : -1
            i += 2
          } else sets[slot - 0x28] = bytes[i++] ?? -1
        }
      }
      continue
    }
    if (byte === 0x0e || byte === 0x0f) {
      gl = byte === 0x0e ? 1 : 0
      continue
    }
    if (byte === 0x19 || byte === 0x1d) {
      single = byte === 0x19 ? 2 : 3
      continue
    }
    if (byte === 0x0d || byte === 0x0a) {
      tokens.push(control(byte))
      continue
    }
    if (byte === 0x20 || byte === 0xa0) {
      tokens.push({ type: 'char', text: ' ' })
      continue
    }
    if (byte === 0x16) {
      tokens.push(control(byte, [bytes[i] ?? 0]))
      i++
      continue
    }
    if (byte === 0x1c) {
      tokens.push(control(byte, [bytes[i] ?? 0, bytes[i + 1] ?? 0]))
      i += 2
      continue
    }
    if (byte < 0x20) {
      tokens.push(control(byte))
      continue
    }
    if (byte === 0x7f) {
      tokens.push(control(byte))
      continue
    }
    if (byte >= 0x80 && byte <= 0x9f) {
      const parsed = readC1(byte, bytes, i)
      tokens.push(parsed.token)
      i = parsed.index
      continue
    }
    if (byte === 0xff) continue
    const set = sets[byte >= 0xa1 ? gr : (single ?? gl)]
    single = null
    const code = byte & 0x7f
    if (set >= 0xc0 && set <= 0xcf) {
      const map = set & 0x0f
      if (map === 0) {
        const next = bytes[i] & 0x7f
        tokens.push({ type: 'drcs', map, code: (code << 8) | next })
        i++
      } else tokens.push({ type: 'drcs', map, code })
    } else if (set === 0x42 || set === 0x39 || set === 0x3a || set === 0x3b) {
      const next = bytes[i] & 0x7f
      if (next >= 0x21 && next <= 0x7e) {
        tokens.push({ type: 'char', text: decodeEuc([code | 0x80, next | 0x80]) })
        i++
      } else tokens.push({ type: 'char', text: REPLACEMENT })
    } else if (set === 0x4a || set === 0x36) {
      tokens.push({ type: 'char', text: String.fromCharCode(code) })
    } else if (set === 0x30 || set === 0x37) {
      tokens.push({ type: 'char', text: decodeHiragana(code) })
    } else if (set === 0x31 || set === 0x38) {
      tokens.push({ type: 'char', text: decodeKatakana(code) })
    } else {
      tokens.push({ type: 'char', text: REPLACEMENT })
    }
  }
  return tokens
}

/** ARIB STD-B24: SI text starts with G0=Kanji, G1=alphanumeric, G2=hiragana, G3=katakana. */
export function decodeAribText(bytes: Uint8Array): string {
  let result = ''
  for (const token of tokenizeAribText(bytes)) {
    if (token.type === 'char') result += token.text
    else if (token.type === 'control' && (token.code === 0x0d || token.code === 0x0a))
      result += '\n'
  }
  return result
}
