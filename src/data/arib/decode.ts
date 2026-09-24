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

function skipEscape(bytes: Uint8Array, index: number): number {
  let i = index + 1
  if (i >= bytes.length) return i
  const next = bytes[i]
  if (next === 0x24 || next === 0x28 || next === 0x29 || next === 0x2a) {
    i++
    if (i < bytes.length) i++
    return i
  }
  if (next === 0x6e || next === 0x6f) return i + 1
  return i + 1
}

/**
 * Decode ARIB STD-B24 8-bit character code to a JavaScript string.
 *
 * GL bytes (0x20-0x7E) are treated as ASCII; GR pairs (0xA1-0xFE, 0xA1-0xFE)
 * are JIS X 0208 and are passed straight to a EUC-JP decoder (ARIB GR values
 * equal the EUC-JP byte values). C0/C1 controls are stripped, CR/LF become
 * newlines, and unknown bytes decode to U+FFFD.
 */
export function decodeAribText(bytes: Uint8Array): string {
  const euc: number[] = []
  let result = ''

  const flush = (): void => {
    if (euc.length > 0) {
      result += decodeEuc(euc)
      euc.length = 0
    }
  }

  let i = 0
  while (i < bytes.length) {
    const byte = bytes[i]

    if (byte === 0x1b) {
      i = skipEscape(bytes, i)
      continue
    }
    if (byte === 0x0d || byte === 0x0a) {
      euc.push(0x0a)
      i++
      continue
    }
    if (
      byte < 0x20 ||
      byte === 0x7f ||
      byte === 0x80 ||
      byte === 0xa0 ||
      (byte >= 0x81 && byte <= 0x9f)
    ) {
      i++
      continue
    }
    if (byte < 0x80) {
      euc.push(byte)
      i++
      continue
    }

    const next = i + 1 < bytes.length ? bytes[i + 1] : -1
    if (next >= 0xa1 && next <= 0xfe) {
      euc.push(byte, next)
      i += 2
      continue
    }

    flush()
    result += REPLACEMENT
    i++
  }

  flush()
  return result
}
