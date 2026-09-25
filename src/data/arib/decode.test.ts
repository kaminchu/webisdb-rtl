import { describe, expect, it } from 'vitest'
import { decodeAribText, tokenizeAribText } from './decode'
import { encodeAribText } from '../../ts/sectionBuilder'

describe('decodeAribText', () => {
  it('decodes SI kanji, alphanumeric locking shifts and mixed text', () => {
    for (const text of ['NHK', 'こんにちは', 'ＮＨＫ総合', 'テスト', 'AこんにちはB']) {
      expect(decodeAribText(encodeAribText(text))).toBe(text)
    }
  })

  it('decodes broadcast network and service names with the initial Kanji set', () => {
    expect(decodeAribText(Uint8Array.from([0x3f, 0x37, 0x33, 0x63, 0x0e, 0x32]))).toBe('新潟2')
    expect(
      decodeAribText(Uint8Array.from([0x0e, 0x42, 0x53, 0x4e, 0x0f, 0x37, 0x48, 0x42, 0x53])),
    ).toBe('BSN携帯')
  })

  it('invokes single-byte hiragana and katakana without consuming pairs', () => {
    expect(decodeAribText(Uint8Array.from([0xb3, 0xf3, 0xcb, 0xc1, 0xcf]))).toBe('こんにちは')
    expect(decodeAribText(Uint8Array.from([0x1d, 0x46, 0x1d, 0x39, 0x1d, 0x48]))).toBe('テスト')
  })

  it('honours two-byte GR designation and locking shift', () => {
    expect(
      decodeAribText(Uint8Array.from([0x1b, 0x24, 0x29, 0x42, 0x1b, 0x7e, 0xc1, 0xed, 0xb9, 0xe7])),
    ).toBe('総合')
  })

  it('maps line breaks and handles truncated kanji', () => {
    expect(decodeAribText(Uint8Array.from([0x0e, 0x41, 0x0d, 0x42]))).toBe('A\nB')
    expect(decodeAribText(Uint8Array.from([0x3f]))).toBe('\ufffd')
    expect(decodeAribText(new Uint8Array(0))).toBe('')
  })

  it('decodes ARIB additional symbols', () => {
    expect(decodeAribText(Uint8Array.from([0x75, 0x21]))).toBe('㐂')
  })

  it('decodes the single-byte kana punctuation tail', () => {
    expect(decodeAribText(Uint8Array.from([0x1b, 0x7c, 0xad, 0xe6, 0xf9, 0xd4, 0xf9]))).toBe(
      'キユーピー',
    )
    expect(decodeAribText(Uint8Array.from([0xf7, 0xf8]))).toBe('ゝゞ')
    expect(decodeAribText(Uint8Array.from([0xf9, 0xfa, 0xfb, 0xfc]))).toBe('ー。「」')
    expect(decodeAribText(Uint8Array.from([0x1b, 0x7c, 0xf7, 0xf8]))).toBe('ヽヾ')
  })

  it('decodes additional symbols invoked through the extra-symbols set', () => {
    expect(decodeAribText(Uint8Array.from([0x1b, 0x24, 0x3b, 0x0f, 0x7a, 0x56]))).toBe('🈑')
  })
})

describe('tokenizeAribText', () => {
  it('emits graphic characters and control functions in order', () => {
    const tokens = tokenizeAribText(Uint8Array.from([0x0c, 0x87, 0x24, 0x33]))
    expect(tokens[0]).toMatchObject({ type: 'control', code: 0x0c })
    expect(tokens[1]).toMatchObject({ type: 'control', code: 0x87 })
    expect(tokens[2]).toMatchObject({ type: 'char', text: 'こ' })
  })

  it('parses CSI parameters and the final byte', () => {
    const tokens = tokenizeAribText(
      Uint8Array.from([0x9b, 0x31, 0x37, 0x30, 0x3b, 0x33, 0x30, 0x5f]),
    )
    expect(tokens[0]).toEqual({
      type: 'control',
      code: 0x9b,
      params: [170, 30],
      final: 0x5f,
    })
  })

  it('accepts ESC [ as a CSI introducer', () => {
    const tokens = tokenizeAribText(Uint8Array.from([0x1b, 0x5b, 0x34, 0x61]))
    expect(tokens[0]).toEqual({ type: 'control', code: 0x9b, params: [4], final: 0x61 })
  })

  it('emits a DRCS reference for a designated DRCS set', () => {
    const tokens = tokenizeAribText(Uint8Array.from([0x1b, 0x28, 0x20, 0x41, 0x21]))
    expect(tokens).toEqual([{ type: 'drcs', map: 1, code: 0x21 }])
  })
})
