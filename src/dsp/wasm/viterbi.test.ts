import { describe, expect, it } from 'vitest'
import type { ViterbiRate } from '../backend'
import { StreamingViterbi, TsViterbiBackend, convolutionalEncodeBit } from '../stages/viterbi'
import { WasmStreamingViterbi, WasmViterbiBackend } from './viterbi'

const RATES: ViterbiRate[] = ['1/2', '2/3', '3/4', '5/6', '7/8']

function prng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s
  }
}

function hardInput(n: number, seed: number): Uint8Array {
  const rand = prng(seed)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = rand() % 3
  return out
}

function softInput(n: number, seed: number): Int8Array {
  const rand = prng(seed)
  const out = new Int8Array(n)
  for (let i = 0; i < n; i++) out[i] = (rand() % 255) - 127
  return out
}

function runTsStreaming(rate: ViterbiRate, soft: Int8Array): number[] {
  const bytes: number[] = []
  const decoder = new StreamingViterbi(rate, (byte) => bytes.push(byte))
  for (let i = 0; i < soft.length; i++) decoder.feedSoft(soft[i])
  return bytes
}

function runWasmStreaming(rate: ViterbiRate, soft: Int8Array): number[] {
  const bytes: number[] = []
  const decoder = new WasmStreamingViterbi(rate, (byte) => bytes.push(byte))
  for (let i = 0; i < soft.length; i++) decoder.feedSoft(soft[i])
  decoder.dispose()
  return bytes
}

describe('WasmViterbiBackend', () => {
  const wasm = new WasmViterbiBackend()
  const ts = new TsViterbiBackend()

  it('exposes the backend interface', () => {
    expect(wasm.name).toBe('wasm-viterbi')
  })

  for (let r = 0; r < RATES.length; r++) {
    const rate = RATES[r]
    for (const terminate of [false, true]) {
      const tag = `${rate} terminate=${terminate}`

      it(`hard-decision matches TypeScript for ${tag}`, () => {
        const input = hardInput(211, 0x1234 + r * 7 + (terminate ? 1 : 0))
        expect(Array.from(wasm.decode(input, rate, terminate))).toEqual(
          Array.from(ts.decode(input, rate, terminate)),
        )
      })

      it(`soft-decision matches TypeScript for ${tag}`, () => {
        const input = softInput(211, 0x5678 + r * 7 + (terminate ? 1 : 0))
        expect(Array.from(wasm.decodeSoft(input, rate, terminate))).toEqual(
          Array.from(ts.decodeSoft(input, rate, terminate)),
        )
      })
    }
  }

  it('returns empty output for empty input', () => {
    expect(Array.from(wasm.decode(new Uint8Array(0), '1/2', false))).toEqual([])
    expect(Array.from(wasm.decodeSoft(new Int8Array(0), '1/2', true))).toEqual([])
  })

  it('recovers an unpunctured rate 1/2 sequence', () => {
    const rand = prng(7)
    const bits: number[] = []
    const encoded: number[] = []
    let state = 0
    for (let i = 0; i < 50; i++) {
      const bit = rand() & 1
      bits.push(bit)
      const result = convolutionalEncodeBit(state, bit)
      state = result.state
      encoded.push(result.outputs[0], result.outputs[1])
    }
    const decoded = wasm.decode(Uint8Array.from(encoded), '1/2', false)
    expect(Array.from(decoded)).toEqual(bits)
  })
})

describe('WasmStreamingViterbi', () => {
  for (let r = 0; r < RATES.length; r++) {
    const rate = RATES[r]

    it(`element-wise feed matches TypeScript for ${rate}`, () => {
      const soft = softInput(400, 0x9e37 + r * 13)
      expect(runWasmStreaming(rate, soft)).toEqual(runTsStreaming(rate, soft))
    })

    it(`feedSoftBlock matches element-wise feeding for ${rate}`, () => {
      const soft = softInput(400, 0x51ed + r * 13)
      const emitted: number[] = []
      const block = new WasmStreamingViterbi(rate, (byte) => emitted.push(byte))
      const returned = block.feedSoftBlock(soft)
      block.dispose()
      expect(Array.from(returned)).toEqual(emitted)
      expect(emitted).toEqual(runWasmStreaming(rate, soft))
      expect(emitted).toEqual(runTsStreaming(rate, soft))
    })

    it(`preserves full traceback through noise, ties, ring wraps and reset for ${rate}`, () => {
      const soft = new Int8Array(16_384)
      let seed = 0x12345678
      for (let i = 0; i < soft.length; i++) {
        seed ^= seed << 13
        seed ^= seed >>> 17
        seed ^= seed << 5
        soft[i] = i % 2048 < 512 ? 0 : (seed & 255) - 128
      }
      const expected = runTsStreaming(rate, soft)
      const decoder = new WasmStreamingViterbi(rate)
      try {
        expect(Array.from(decoder.feedSoftBlock(soft))).toEqual(expected)
        decoder.reset()
        const chunked: number[] = []
        for (let i = 0; i < soft.length; i += 113) {
          chunked.push(...decoder.feedSoftBlock(soft.subarray(i, i + 113)))
        }
        expect(chunked).toEqual(expected)
      } finally {
        decoder.dispose()
      }
    })
  }

  it('feedSoftBlock matches feeding in chunks', () => {
    const soft = softInput(512, 0xabcdef)
    const whole: number[] = []
    const wholeDecoder = new WasmStreamingViterbi('7/8', (b) => whole.push(b))
    wholeDecoder.feedSoftBlock(soft)
    wholeDecoder.dispose()

    const chunked: number[] = []
    const chunkDecoder = new WasmStreamingViterbi('7/8', (b) => chunked.push(b))
    for (let i = 0; i < soft.length; i += 17) {
      const slice = soft.slice(i, i + 17)
      chunkDecoder.feedSoftBlock(slice)
    }
    chunkDecoder.dispose()

    expect(chunked).toEqual(whole)
  })

  it('reset clears streaming state', () => {
    const soft = softInput(321, 99)
    const sink: number[] = []
    const decoder = new WasmStreamingViterbi('3/4', (b) => sink.push(b))
    decoder.feedSoftBlock(soft.slice(0, 100))
    decoder.reset()
    sink.length = 0
    decoder.feedSoftBlock(soft)
    decoder.dispose()

    const fresh: number[] = []
    const reference = new WasmStreamingViterbi('3/4', (b) => fresh.push(b))
    reference.feedSoftBlock(soft)
    reference.dispose()

    expect(sink).toEqual(fresh)
  })
})
