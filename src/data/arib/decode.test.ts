import { describe, expect, it } from 'vitest'
import { decodeAribText } from './decode'

const KONNICHIWA = Uint8Array.from([0xa4, 0xb3, 0xa4, 0xf3, 0xa4, 0xcb, 0xa4, 0xc1, 0xa4, 0xcf])
const NHK_SOUGOU = Uint8Array.from([0xa3, 0xce, 0xa3, 0xc8, 0xa3, 0xcb, 0xc1, 0xed, 0xb9, 0xe7])
const TEST = Uint8Array.from([0xa5, 0xc6, 0xa5, 0xb9, 0xa5, 0xc8])

describe('decodeAribText', () => {
  it('decodes ASCII (GL)', () => {
    expect(decodeAribText(Uint8Array.from([0x4e, 0x48, 0x4b]))).toBe('NHK')
  })

  it('decodes JIS X 0208 (GR) text', () => {
    expect(decodeAribText(KONNICHIWA)).toBe('こんにちは')
    expect(decodeAribText(NHK_SOUGOU)).toBe('ＮＨＫ総合')
    expect(decodeAribText(TEST)).toBe('テスト')
  })

  it('decodes mixed ASCII and kana', () => {
    const bytes = Uint8Array.from([0x41, ...KONNICHIWA, 0x42])
    expect(decodeAribText(bytes)).toBe('AこんにちはB')
  })

  it('maps CR/LF to newlines and strips C0/C1 controls', () => {
    expect(decodeAribText(Uint8Array.from([0x41, 0x0d, 0x42]))).toBe('A\nB')
    expect(decodeAribText(Uint8Array.from([0x41, 0x01, 0x42]))).toBe('AB')
    expect(decodeAribText(Uint8Array.from([0x41, 0x85, 0x42]))).toBe('AB')
  })

  it('skips escape designation sequences', () => {
    expect(decodeAribText(Uint8Array.from([0x1b, 0x24, 0x42, ...KONNICHIWA]))).toBe('こんにちは')
  })

  it('emits a replacement character for unknown bytes', () => {
    expect(decodeAribText(Uint8Array.from([0x41, 0xa4, 0x20]))).toBe('A\ufffd ')
  })

  it('returns an empty string for empty input', () => {
    expect(decodeAribText(new Uint8Array(0))).toBe('')
  })
})
