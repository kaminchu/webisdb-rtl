import { describe, expect, it } from 'vitest'
import { CarrierModulation, MODE_PARAMS, TransmissionMode } from '../isdbtParams'
import type { ComplexPlane } from './carrierDemod'
import {
  BIT_INTERLEAVER_MAX_DELAY,
  BitDeinterleaver,
  ByteDeinterleaver,
  TimeDeinterleaver,
  bitDeinterleaveDelays,
  frequencyDeinterleave,
  frequencyInterleave,
  frequencyPermutation,
} from './deinterleave'

function isPermutation(values: readonly number[], size: number): boolean {
  if (values.length !== size) return false
  const seen = new Uint8Array(size)
  for (const v of values) {
    if (v < 0 || v >= size || seen[v] === 1) return false
    seen[v] = 1
  }
  return true
}

describe('frequency deinterleaving', () => {
  it('uses a full permutation per mode', () => {
    expect(isPermutation(frequencyPermutation(1), 96)).toBe(true)
    expect(isPermutation(frequencyPermutation(2), 192)).toBe(true)
    expect(isPermutation(frequencyPermutation(3), 384)).toBe(true)
  })

  it('round-trips interleave then deinterleave', () => {
    for (const mode of [1, 2, 3] as TransmissionMode[]) {
      const size = MODE_PARAMS[mode].dataCarriersPerSegment
      const re = new Float32Array(size)
      const im = new Float32Array(size)
      for (let k = 0; k < size; k++) {
        re[k] = Math.sin(k * 0.7)
        im[k] = Math.cos(k * 1.3)
      }
      const plane: ComplexPlane = { re, im }
      const recovered = frequencyDeinterleave(frequencyInterleave(plane, mode), mode)
      expect(Array.from(recovered.re)).toEqual(Array.from(re))
      expect(Array.from(recovered.im)).toEqual(Array.from(im))
    }
  })
})

function bitInterleave(input: Uint8Array, delays: readonly number[]): Uint8Array {
  const max = BIT_INTERLEAVER_MAX_DELAY
  const out = new Uint8Array(input.length)
  for (let b = 0; b < delays.length; b++) {
    const delay = max - delays[b]
    for (let t = 0; t < input.length; t++) {
      const src = t - delay
      if (src >= 0) out[t] |= ((input[src] >> b) & 1) << b
    }
  }
  return out
}

describe('bit deinterleaving', () => {
  it('exposes the standard delay profiles', () => {
    expect(bitDeinterleaveDelays(CarrierModulation.DQPSK)).toEqual([120, 0])
    expect(bitDeinterleaveDelays(CarrierModulation.QPSK)).toEqual([120, 0])
    expect(bitDeinterleaveDelays(CarrierModulation.QAM16)).toEqual([120, 80, 40, 0])
    expect(bitDeinterleaveDelays(CarrierModulation.QAM64)).toEqual([120, 96, 72, 48, 24, 0])
  })

  it('recovers an interleaved stream with a constant latency', () => {
    const input = new Uint8Array(400)
    for (let i = 0; i < input.length; i++) input[i] = (i * 37 + 11) & 0b11
    const delays = bitDeinterleaveDelays(CarrierModulation.QPSK)
    const interleaved = bitInterleave(input, delays)
    const deinterleaver = new BitDeinterleaver(CarrierModulation.QPSK)
    const output = deinterleaver.process(interleaved)
    for (let t = BIT_INTERLEAVER_MAX_DELAY; t < input.length; t++) {
      expect(output[t]).toBe(input[t - BIT_INTERLEAVER_MAX_DELAY])
    }
  })
})

function timeInterleaveRe(input: Float32Array[], I: number, carriers: number): Float32Array[] {
  const buffers: Float32Array[] = []
  const pos = new Int32Array(carriers)
  for (let c = 0; c < carriers; c++) {
    const mi = (5 * c) % 96
    buffers[c] = new Float32Array(I * mi + 1)
  }
  return input.map((frame) => {
    const out = new Float32Array(carriers)
    for (let c = 0; c < carriers; c++) {
      const depth = buffers[c].length
      const p = pos[c]
      const read = (p + 1) % depth
      buffers[c][p] = frame[c]
      out[c] = buffers[c][read]
      pos[c] = read
    }
    return out
  })
}

describe('time deinterleaving', () => {
  it('is a pass-through when I = 0', () => {
    const deinterleaver = new TimeDeinterleaver(1, 0)
    const re = Float32Array.from({ length: 96 }, (_, i) => i)
    const im = new Float32Array(96)
    const out = deinterleaver.process(re, im)
    expect(Array.from(out.re)).toEqual(Array.from(re))
  })

  it('recovers a convolutionally interleaved stream', () => {
    const I = 1
    const carriers = MODE_PARAMS[1].dataCarriersPerSegment
    const frames = 100
    const input: Float32Array[] = []
    for (let t = 0; t < frames; t++) {
      const frame = new Float32Array(carriers)
      for (let c = 0; c < carriers; c++) frame[c] = Math.sin(t * 0.3 + c * 0.11)
      input.push(frame)
    }
    const interleaved = timeInterleaveRe(input, I, carriers)
    const deinterleaver = new TimeDeinterleaver(1, I)
    const latency = I * 95
    for (let t = 0; t < frames; t++) {
      const out = deinterleaver.process(interleaved[t], new Float32Array(carriers))
      if (t >= latency) {
        for (let c = 0; c < carriers; c++) {
          expect(out.re[c]).toBeCloseTo(input[t - latency][c], 5)
        }
      }
    }
  })
})

function byteInterleave(input: Uint8Array): Uint8Array {
  const branches = 12
  const m = 17
  const buffers: Uint8Array[] = []
  const pos = new Int32Array(branches)
  for (let b = 0; b < branches; b++) buffers[b] = new Uint8Array(1 + m * b)
  const out = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const b = i % branches
    const depth = buffers[b].length
    const p = pos[b]
    const read = (p + 1) % depth
    buffers[b][p] = input[i]
    out[i] = buffers[b][read]
    pos[b] = read
  }
  return out
}

describe('byte deinterleaving', () => {
  it('recovers a convolutionally interleaved byte stream', () => {
    const input = new Uint8Array(3000)
    for (let i = 0; i < input.length; i++) input[i] = (i * 13 + 5) & 0xff
    const interleaved = byteInterleave(input)
    const deinterleaver = new ByteDeinterleaver()
    const output = deinterleaver.process(interleaved)
    const latency = 17 * 11 * 12
    for (let t = latency; t < input.length; t++) {
      expect(output[t]).toBe(input[t - latency])
    }
  })
})
