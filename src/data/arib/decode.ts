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

function decodeEuc(bytes: number[]): string {
  if (bytes.length === 0) return ''
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

/** ARIB STD-B24: SI text starts with G0=Kanji, G1=alphanumeric, G2=hiragana, G3=katakana. */
export function decodeAribText(bytes: Uint8Array): string {
  const sets = [0x42, 0x4a, 0x30, 0x31]
  let gl = 0
  let gr = 2
  let single: number | null = null
  let result = ''
  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i++]
    if (byte === 0x1b) {
      const next = bytes[i++]
      if (next === 0x6e || next === 0x6f) gl = next - 0x6c
      else if (next >= 0x7c && next <= 0x7e) gr = 0x7f - next
      else {
        let slot = next
        if (next === 0x24) slot = bytes[i] >= 0x28 && bytes[i] <= 0x2b ? bytes[i++] : 0x28
        if (slot >= 0x28 && slot <= 0x2b) {
          if (bytes[i] === 0x20) {
            i += 2
            sets[slot - 0x28] = -1
          } else sets[slot - 0x28] = bytes[i++]
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
      result += '\n'
      continue
    }
    if (byte === 0x20 || byte === 0xa0) {
      result += ' '
      continue
    }
    if (byte < 0x20 || (byte >= 0x7f && byte <= 0xa0) || byte === 0xff) continue
    const set = sets[byte >= 0xa1 ? gr : (single ?? gl)]
    single = null
    const code = byte & 0x7f
    if (set === 0x42 || set === 0x39 || set === 0x3a) {
      const next = bytes[i] & 0x7f
      if (next >= 0x21 && next <= 0x7e) {
        result += decodeEuc([code | 0x80, next | 0x80])
        i++
      } else result += REPLACEMENT
    } else if (set === 0x4a || set === 0x36) result += String.fromCharCode(code)
    else if (set === 0x30 || set === 0x37) result += decodeEuc([0xa4, code | 0x80])
    else if (set === 0x31 || set === 0x38) result += decodeEuc([0xa5, code | 0x80])
    else result += REPLACEMENT
  }
  return result
}
