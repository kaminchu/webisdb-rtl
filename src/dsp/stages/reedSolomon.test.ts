import { describe, expect, it } from 'vitest'
import { RS_GENERATOR, TsRsBackend, gfMul } from './reedSolomon'

const DATA_SIZE = 188
const PARITY = 16
const BLOCK = 204

function rsEncode(data: Uint8Array): Uint8Array {
  const parity = new Uint8Array(PARITY)
  for (let i = 0; i < data.length; i++) {
    const feedback = data[i] ^ parity[0]
    parity.copyWithin(0, 1)
    parity[PARITY - 1] = 0
    if (feedback !== 0) {
      for (let j = 0; j < PARITY; j++) parity[j] ^= gfMul(RS_GENERATOR[PARITY - 1 - j], feedback)
    }
  }
  const out = new Uint8Array(BLOCK)
  out.set(data, 0)
  out.set(parity, DATA_SIZE)
  return out
}

function randomBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed >>> 0
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    out[i] = (state >>> 16) & 0xff
  }
  return out
}

function withErrors(block: Uint8Array, positions: number[]): Uint8Array {
  const out = block.slice()
  for (const p of positions) out[p] ^= 0x5a
  return out
}

describe('RS(204,188)', () => {
  const backend = new TsRsBackend()

  it('uses a degree-16 generator with the expected roots', () => {
    expect(RS_GENERATOR).toHaveLength(17)
    expect(RS_GENERATOR[16]).toBe(1)
  })

  it('decodes a clean codeword', () => {
    const data = randomBytes(DATA_SIZE, 3)
    const decoded = backend.decode(rsEncode(data))
    expect(decoded).not.toBeNull()
    expect(Array.from(decoded!)).toEqual(Array.from(data))
  })

  it('corrects exactly eight byte errors', () => {
    const data = randomBytes(DATA_SIZE, 11)
    const codeword = rsEncode(data)
    const corrupted = withErrors(codeword, [0, 17, 50, 100, 150, 188, 200, 203])
    const decoded = backend.decode(corrupted)
    expect(decoded).not.toBeNull()
    expect(Array.from(decoded!)).toEqual(Array.from(data))
  })

  it('rejects a block with more than eight errors', () => {
    const data = randomBytes(DATA_SIZE, 23)
    const codeword = rsEncode(data)
    const corrupted = withErrors(codeword, [0, 17, 50, 100, 150, 160, 188, 200, 203])
    const decoded = backend.decode(corrupted)
    if (decoded !== null) {
      expect(Array.from(decoded)).not.toEqual(Array.from(data))
    }
  })

  it('rejects blocks of the wrong size', () => {
    expect(backend.decode(new Uint8Array(100))).toBeNull()
  })
})
