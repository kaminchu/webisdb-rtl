import { describe, expect, it } from 'vitest'
import type { ViterbiRate } from '../backend'
import { PUNCTURE_PATTERNS, TsViterbiBackend, convolutionalEncodeBit, depuncture } from './viterbi'

function encode(bits: Uint8Array): Uint8Array {
  let state = 0
  const out: number[] = []
  for (let i = 0; i < bits.length; i++) {
    const result = convolutionalEncodeBit(state, bits[i])
    out.push(result.outputs[0], result.outputs[1])
    state = result.state
  }
  return Uint8Array.from(out)
}

function puncture(bits: Uint8Array, rate: ViterbiRate): Uint8Array {
  const pattern = PUNCTURE_PATTERNS[rate]
  const out: number[] = []
  for (let i = 0; i < bits.length; i++) {
    if (pattern[i % pattern.length] === 1) out.push(bits[i])
  }
  return Uint8Array.from(out)
}

function randomBits(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed >>> 0
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    out[i] = (state >>> 16) & 1
  }
  return out
}

function withTail(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(bits.length + 6)
  out.set(bits, 0)
  return out
}

describe('depuncturing', () => {
  it('reinserts erasures at the punctured positions', () => {
    const depunctured = depuncture(Uint8Array.from([1, 0, 1]), '2/3')
    expect(Array.from(depunctured)).toEqual([1, 0, 2, 1])
  })

  it('uses the standard patterns', () => {
    expect(PUNCTURE_PATTERNS['1/2']).toHaveLength(2)
    expect(PUNCTURE_PATTERNS['2/3']).toHaveLength(4)
    expect(PUNCTURE_PATTERNS['3/4']).toHaveLength(6)
    expect(PUNCTURE_PATTERNS['5/6']).toHaveLength(10)
    expect(PUNCTURE_PATTERNS['7/8']).toHaveLength(14)
  })
})

describe('TsViterbiBackend', () => {
  const backend = new TsViterbiBackend()

  it('decodes rate 1/2 with termination', () => {
    const info = randomBits(300, 1)
    const coded = encode(withTail(info))
    const decoded = backend.decode(coded, '1/2', true)
    expect(decoded).toHaveLength(info.length)
    expect(Array.from(decoded)).toEqual(Array.from(info))
  })

  for (const rate of ['2/3', '3/4', '5/6', '7/8'] as ViterbiRate[]) {
    it(`decodes rate ${rate} with termination`, () => {
      const info = randomBits(420, rate.length)
      const coded = puncture(encode(withTail(info)), rate)
      const decoded = backend.decode(coded, rate, true)
      expect(decoded).toHaveLength(info.length)
      expect(Array.from(decoded)).toEqual(Array.from(info))
    })
  }

  it('decodes a continuous (unterminated) stream', () => {
    const info = randomBits(256, 7)
    const coded = encode(info)
    const decoded = backend.decode(coded, '1/2', false)
    expect(Array.from(decoded)).toEqual(Array.from(info))
  })
})
