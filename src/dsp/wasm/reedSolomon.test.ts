import { describe, expect, it } from 'vitest'
import { RS_GENERATOR, TsRsBackend, gfMul } from '../stages/reedSolomon'
import { WasmRsBackend } from './reedSolomon'

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

describe('WasmRsBackend', () => {
  const wasm = new WasmRsBackend()
  const ts = new TsRsBackend()

  it('exposes the backend interface', () => {
    expect(wasm.name).toBe('wasm-rs')
  })

  it('matches the TypeScript decoder on a clean codeword', () => {
    const data = randomBytes(DATA_SIZE, 3)
    const block = rsEncode(data)
    const w = wasm.decode(block)
    const t = ts.decode(block)
    expect(w).not.toBeNull()
    expect(Array.from(w!)).toEqual(Array.from(t!))
    expect(Array.from(w!)).toEqual(Array.from(data))
  })

  it('matches the TypeScript decoder with exactly eight byte errors', () => {
    const data = randomBytes(DATA_SIZE, 11)
    const corrupted = withErrors(rsEncode(data), [0, 17, 50, 100, 150, 188, 200, 203])
    const w = wasm.decode(corrupted)
    const t = ts.decode(corrupted)
    expect(w).not.toBeNull()
    expect(Array.from(w!)).toEqual(Array.from(t!))
    expect(Array.from(w!)).toEqual(Array.from(data))
  })

  it('returns null like TypeScript with more than eight byte errors', () => {
    const data = randomBytes(DATA_SIZE, 23)
    const corrupted = withErrors(rsEncode(data), [0, 17, 50, 100, 150, 160, 188, 200, 203])
    const w = wasm.decode(corrupted)
    const t = ts.decode(corrupted)
    expect(w).toBeNull()
    expect(t).toBeNull()
    if (w !== null && t !== null) expect(Array.from(w)).toEqual(Array.from(t))
  })

  it('returns null like TypeScript for blocks of the wrong size', () => {
    expect(wasm.decode(new Uint8Array(100))).toBeNull()
    expect(ts.decode(new Uint8Array(100))).toBeNull()
  })
})
