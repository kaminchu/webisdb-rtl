import { describe, expect, it } from 'vitest'
import { decodeAribText } from './decode'
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
})
