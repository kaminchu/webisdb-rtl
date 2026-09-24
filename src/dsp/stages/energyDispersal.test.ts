import { describe, expect, it } from 'vitest'
import {
  EnergyDescrambler,
  ENERGY_DISPERSAL_INIT,
  RS_CODEWORD_SIZE,
  SYNC_BYTE,
} from './energyDispersal'

class TestPrbs {
  private reg = ENERGY_DISPERSAL_INIT

  clock(count: number): number {
    let result = 0
    for (let i = 0; i < count; i++) {
      const feedback = ((this.reg >> 13) ^ (this.reg >> 14)) & 1
      this.reg = ((this.reg << 1) | feedback) & 0x7fff
      result = (result << 1) | feedback
    }
    return result
  }
}

function scramble(codeword: Uint8Array): Uint8Array {
  const prbs = new TestPrbs()
  const out = new Uint8Array(RS_CODEWORD_SIZE)
  for (let j = 0; j < RS_CODEWORD_SIZE - 1; j++) {
    out[j] = codeword[j + 1] ^ prbs.clock(8)
  }
  out[RS_CODEWORD_SIZE - 1] = codeword[0]
  prbs.clock(8)
  return out
}

describe('energy dispersal', () => {
  it('descrambles a scrambled codeword', () => {
    const codeword = new Uint8Array(RS_CODEWORD_SIZE)
    codeword[0] = SYNC_BYTE
    for (let i = 1; i < codeword.length; i++) codeword[i] = (i * 29 + 7) & 0xff
    const scrambled = scramble(codeword)
    expect(scrambled[RS_CODEWORD_SIZE - 1]).toBe(SYNC_BYTE)
    const descrambler = new EnergyDescrambler()
    const recovered = descrambler.processBlock(scrambled)
    expect(Array.from(recovered)).toEqual(Array.from(codeword))
  })

  it('produces the ARIB STD-B31 PRBS sequence', () => {
    const prbs = new TestPrbs()
    expect(prbs.clock(8)).toBe(0b00000011)
    expect(prbs.clock(8)).toBe(0b11110110)
  })

  it('resets to the initial state', () => {
    const descrambler = new EnergyDescrambler()
    const block = new Uint8Array(RS_CODEWORD_SIZE).fill(0xab)
    const first = descrambler.processBlock(block)
    descrambler.reset()
    expect(Array.from(descrambler.processBlock(block))).toEqual(Array.from(first))
  })
})
