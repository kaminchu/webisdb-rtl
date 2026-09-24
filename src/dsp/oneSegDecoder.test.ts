import { describe, expect, it } from 'vitest'
import { CarrierModulation, CodeRate, MODE_PARAMS, TransmissionMode } from './isdbtParams'
import type { TmccInfo } from '../models/tmcc'
import { OneSegDecoder } from './oneSegDecoder'
import { RS_GENERATOR, gfMul } from './stages/reedSolomon'
import {
  ENERGY_DISPERSAL_INIT,
  RS_CODEWORD_SIZE,
  SYNC_BYTE,
  TS_PACKET_SIZE,
} from './stages/energyDispersal'
import { frequencyInterleave } from './stages/deinterleave'
import { convolutionalEncodeBit } from './stages/viterbi'
import type { ComplexPlane } from './stages/carrierDemod'

const DATA_SIZE = 188
const PARITY = 16
const CARRIERS = MODE_PARAMS[3].dataCarriersPerSegment

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
  const out = new Uint8Array(RS_CODEWORD_SIZE)
  out.set(data, 0)
  out.set(parity, DATA_SIZE)
  return out
}

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

function energyScramble(codeword: Uint8Array, prbs: TestPrbs): Uint8Array {
  const out = new Uint8Array(RS_CODEWORD_SIZE)
  for (let j = 0; j < RS_CODEWORD_SIZE - 1; j++) out[j] = codeword[j + 1] ^ prbs.clock(8)
  out[RS_CODEWORD_SIZE - 1] = codeword[0]
  prbs.clock(8)
  return out
}

function convolutionallyEncode(bits: Uint8Array): Uint8Array {
  let state = 0
  const out = new Uint8Array(bits.length * 2)
  for (let i = 0; i < bits.length; i++) {
    const result = convolutionalEncodeBit(state, bits[i])
    out[2 * i] = result.outputs[0]
    out[2 * i + 1] = result.outputs[1]
    state = result.state
  }
  return out
}

function bytesToBits(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length * 8)
  let o = 0
  for (let i = 0; i < bytes.length; i++) {
    for (let j = 7; j >= 0; j--) out[o++] = (bytes[i] >> j) & 1
  }
  return out
}

const BIT_DELAYS = [0, 120]
const BIT_MAX = 120

function bitInterleave(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length)
  for (let b = 0; b < BIT_DELAYS.length; b++) {
    const delay = BIT_MAX - BIT_DELAYS[b]
    for (let t = 0; t < input.length; t++) {
      const src = t - delay
      if (src >= 0) out[t] |= ((input[src] >> b) & 1) << b
    }
  }
  return out
}

function makeTsPacket(index: number): Uint8Array {
  const packet = new Uint8Array(TS_PACKET_SIZE)
  packet[0] = SYNC_BYTE
  packet[1] = 0x00
  packet[2] = (index >> 8) & 0xff
  packet[3] = index & 0xff
  for (let i = 4; i < TS_PACKET_SIZE; i++) packet[i] = (index * 31 + i * 7) & 0xff
  return packet
}

function buildSymbols(carrierBytes: Uint8Array, mode: TransmissionMode): ComplexPlane[] {
  const symbolCount = carrierBytes.length / CARRIERS
  const reference: ComplexPlane = {
    re: new Float32Array(CARRIERS).fill(1),
    im: new Float32Array(CARRIERS),
  }
  const phase = new Float32Array(CARRIERS)
  const planes: ComplexPlane[] = [frequencyInterleave(reference, mode)]
  for (let s = 0; s < symbolCount; s++) {
    const re = new Float32Array(CARRIERS)
    const im = new Float32Array(CARRIERS)
    for (let k = 0; k < CARRIERS; k++) {
      const label = carrierBytes[s * CARRIERS + k]
      const index = label ^ (label >> 1)
      phase[k] += (index * Math.PI) / 2
      re[k] = Math.cos(phase[k])
      im[k] = Math.sin(phase[k])
    }
    planes.push(frequencyInterleave({ re, im }, mode))
  }
  return planes
}

function makeTmcc(): TmccInfo {
  return {
    locked: true,
    mode: 3,
    guardIntervalRatio: 8,
    partialReception: true,
    systemDescriptor: 0,
    layers: {
      A: {
        modulation: CarrierModulation.DQPSK,
        codeRate: CodeRate.R1_2,
        timeInterleave: 0,
        segments: 1,
      },
      B: null,
      C: null,
    },
    frameCount: 0,
  }
}

function transmit(packets: Uint8Array[]): ComplexPlane[] {
  const encoded: number[] = []
  const prbs = new TestPrbs()
  for (const packet of packets) {
    const codeword = energyScramble(rsEncode(packet), prbs)
    for (let i = 0; i < codeword.length; i++) encoded.push(codeword[i])
  }
  const infoBits = bytesToBits(Uint8Array.from(encoded))
  const paddedInfo = new Uint8Array(infoBits.length + CARRIERS)
  paddedInfo.set(infoBits, 0)
  const codedBits = convolutionallyEncode(paddedInfo)
  const carrierBytes = new Uint8Array(codedBits.length / 2)
  for (let i = 0; i < carrierBytes.length; i++) {
    carrierBytes[i] = (codedBits[2 * i] << 1) | codedBits[2 * i + 1]
  }
  return buildSymbols(bitInterleave(carrierBytes), 3)
}

describe('OneSegDecoder', () => {
  it('recovers TS packets through the full chain', () => {
    const packets = [makeTsPacket(0), makeTsPacket(1), makeTsPacket(2), makeTsPacket(3)]
    const symbols = transmit(packets)
    const decoder = new OneSegDecoder(makeTmcc())
    const output = decoder.decode(symbols)
    expect(output).toHaveLength(packets.length * TS_PACKET_SIZE)
    for (let p = 0; p < packets.length; p++) {
      const slice = output.subarray(p * TS_PACKET_SIZE, (p + 1) * TS_PACKET_SIZE)
      expect(slice[0]).toBe(SYNC_BYTE)
      expect(Array.from(slice)).toEqual(Array.from(packets[p]))
    }
    expect(decoder.tsStats.packets).toBe(packets.length)
    expect(decoder.tsStats.syncErrors).toBe(0)
  })

  it('is deterministic', () => {
    const packets = [makeTsPacket(7), makeTsPacket(8)]
    const symbols = transmit(packets)
    const first = new OneSegDecoder(makeTmcc()).decode(symbols)
    const second = new OneSegDecoder(makeTmcc()).decode(symbols)
    expect(Array.from(first)).toEqual(Array.from(second))
  })
})
