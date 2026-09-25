import { describe, expect, it } from 'vitest'
import { CarrierModulation, MODE_PARAMS, type TransmissionMode } from '../isdbtParams'
import {
  bitDeinterleaveDelays,
  ByteDeinterleaver,
  frequencyDeinterleave,
  frequencyInterleave,
  frequencyPermutation,
  SoftBitDeinterleaver,
  TimeDeinterleaver,
} from '../stages/deinterleave'
import {
  frequencyDeinterleaveWasm,
  frequencyInterleaveWasm,
  WasmByteDeinterleaver,
  WasmSoftBitDeinterleaver,
  WasmTimeDeinterleaver,
} from './deinterleave'

const MODES: readonly TransmissionMode[] = [1, 2, 3]

function randomF32(n: number, seed: number): Float32Array {
  const out = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    out[i] = s / 0x3fffffff - 1
  }
  return out
}

function randomI8(n: number, seed: number): Int8Array {
  const out = new Int8Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    out[i] = (s % 256) - 128
  }
  return out
}

function randomU8(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
    out[i] = (s >> 8) & 0xff
  }
  return out
}

describe('frequency (de)interleave wasm', () => {
  for (const mode of MODES) {
    const size = frequencyPermutation(mode).length

    it(`matches the TS permutation for mode ${mode} over all rotations and calls`, () => {
      for (const rotation of [0, 1, 7, size - 1, size + 3, -2]) {
        const re = randomF32(size, 0x1234 + mode * 17 + rotation)
        const im = randomF32(size, 0x5678 + mode * 17 + rotation)
        const plane = { re, im }

        const wasmDeint = frequencyDeinterleaveWasm(plane, mode, rotation)
        const tsDeint = frequencyDeinterleave(plane, mode, rotation)
        expect(Array.from(wasmDeint.re)).toEqual(Array.from(tsDeint.re))
        expect(Array.from(wasmDeint.im)).toEqual(Array.from(tsDeint.im))

        const wasmInt = frequencyInterleaveWasm(plane, mode, rotation)
        const tsInt = frequencyInterleave(plane, mode, rotation)
        expect(Array.from(wasmInt.re)).toEqual(Array.from(tsInt.re))
        expect(Array.from(wasmInt.im)).toEqual(Array.from(tsInt.im))
      }
    })
  }

  it('round-trips deinterleave then interleave for every mode', () => {
    for (const mode of MODES) {
      const size = frequencyPermutation(mode).length
      const plane = { re: randomF32(size, 99 + mode), im: randomF32(size, 41 + mode) }
      const round = frequencyInterleaveWasm(frequencyDeinterleaveWasm(plane, mode, 3), mode, 3)
      expect(Array.from(round.re)).toEqual(Array.from(plane.re))
      expect(Array.from(round.im)).toEqual(Array.from(plane.im))
    }
  })
})

describe('WasmSoftBitDeinterleaver', () => {
  const modulations: readonly CarrierModulation[] = [
    CarrierModulation.DQPSK,
    CarrierModulation.QPSK,
    CarrierModulation.QAM16,
    CarrierModulation.QAM64,
  ]

  for (const modulation of modulations) {
    it(`matches the TS soft bit deinterleaver for modulation ${modulation}`, () => {
      const labelBits = bitDeinterleaveDelays(modulation).length
      const perCall = 37 * labelBits
      const ts = new SoftBitDeinterleaver(modulation)
      const wasm = new WasmSoftBitDeinterleaver(modulation)

      for (let call = 0; call < 4; call++) {
        const input = randomI8(perCall, 0xabc + modulation * 101 + call)
        const tsOut = ts.process(input)
        const wasmOut = wasm.process(input)
        expect(Array.from(wasmOut)).toEqual(Array.from(tsOut))
      }
    })
  }

  it('reset restores the same state on both implementations', () => {
    const ts = new SoftBitDeinterleaver(CarrierModulation.QAM64)
    const wasm = new WasmSoftBitDeinterleaver(CarrierModulation.QAM64)
    const input = randomI8(600, 4242)
    const first = ts.process(input)
    wasm.process(input)
    ts.reset()
    wasm.reset()
    expect(Array.from(wasm.process(input))).toEqual(Array.from(ts.process(input)))
    expect(Array.from(first).length).toBe(600)
  })
})

describe('WasmTimeDeinterleaver', () => {
  for (const mode of MODES) {
    const carriers = MODE_PARAMS[mode].dataCarriersPerSegment
    for (const I of [0, 1, 2, 4]) {
      it(`matches the TS time deinterleaver for mode ${mode} I=${I}`, () => {
        const ts = new TimeDeinterleaver(mode, I)
        const wasm = new WasmTimeDeinterleaver(mode, I)
        for (let call = 0; call < 3; call++) {
          const re = randomF32(carriers, 0x1111 + mode * 31 + I * 7 + call)
          const im = randomF32(carriers, 0x2222 + mode * 31 + I * 7 + call)
          const tsOut = ts.process(re, im)
          const wasmOut = wasm.process(re, im)
          for (let c = 0; c < carriers; c++) {
            expect(wasmOut.re[c]).toBeCloseTo(tsOut.re[c], 5)
            expect(wasmOut.im[c]).toBeCloseTo(tsOut.im[c], 5)
          }
        }
      })
    }
  }
})

describe('WasmTimeDeinterleaver fused frequency+time', () => {
  for (const mode of MODES) {
    const carriers = MODE_PARAMS[mode].dataCarriersPerSegment
    for (const I of [0, 1, 4]) {
      it(`matches the two-step path for mode ${mode} I=${I}`, () => {
        const fused = new WasmTimeDeinterleaver(mode, I)
        const twoStep = new WasmTimeDeinterleaver(mode, I)
        for (let call = 0; call < 3; call++) {
          const plane = {
            re: randomF32(carriers, 0x3333 + mode * 31 + I * 7 + call),
            im: randomF32(carriers, 0x4444 + mode * 31 + I * 7 + call),
          }
          const fusedOut = fused.processFrequencyDeinterleaved(plane, mode)
          const deinterleaved = frequencyDeinterleaveWasm(plane, mode)
          const stepOut = twoStep.process(deinterleaved.re, deinterleaved.im)
          for (let c = 0; c < carriers; c++) {
            expect(fusedOut.re[c]).toBeCloseTo(stepOut.re[c], 5)
            expect(fusedOut.im[c]).toBeCloseTo(stepOut.im[c], 5)
          }
        }
      })
    }
  }
})

describe('WasmByteDeinterleaver', () => {
  it('matches the TS byte deinterleaver over multiple calls', () => {
    const ts = new ByteDeinterleaver()
    const wasm = new WasmByteDeinterleaver()
    for (let call = 0; call < 4; call++) {
      const input = randomU8(777, 0x9000 + call * 13)
      const tsOut = ts.process(input)
      const wasmOut = wasm.process(input)
      expect(Array.from(wasmOut)).toEqual(Array.from(tsOut))
    }
  })

  it('matches processByte state across many bytes', () => {
    const ts = new ByteDeinterleaver()
    const wasm = new WasmByteDeinterleaver()
    let s = 0x51ed
    for (let i = 0; i < 2000; i++) {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff
      const value = (s >> 8) & 0xff
      expect(wasm.processByte(value)).toBe(ts.processByte(value))
    }
  })

  it('reset restores the same state on both implementations', () => {
    const ts = new ByteDeinterleaver()
    const wasm = new WasmByteDeinterleaver()
    const input = randomU8(513, 0x77)
    ts.process(input)
    wasm.process(input)
    ts.reset()
    wasm.reset()
    const a = randomU8(513, 0x78)
    expect(Array.from(wasm.process(a))).toEqual(Array.from(ts.process(a)))
  })
})
