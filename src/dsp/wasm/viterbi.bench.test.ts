import { it } from 'vitest'
import type { ViterbiRate } from '../backend'
import { WasmStreamingViterbi } from './viterbi'

it.skipIf(process.env.RUN_VITERBI_BENCHMARK !== '1')(
  'benchmarks streaming Viterbi including host copies',
  () => {
    const soft = new Int8Array(32_768)
    let seed = 0x12345678
    for (let i = 0; i < soft.length; i++) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      soft[i] = (seed & 255) - 128
    }
    for (const rate of ['1/2', '2/3', '3/4'] as ViterbiRate[]) {
      const decoder = new WasmStreamingViterbi(rate)
      try {
        for (let i = 0; i < 20; i++) decoder.feedSoftBlock(soft)
        const timings: number[] = []
        for (let i = 0; i < 51; i++) {
          const start = performance.now()
          decoder.feedSoftBlock(soft)
          timings.push(performance.now() - start)
        }
        console.log({
          rate,
          softBits: soft.length,
          medianMs: timings.toSorted((a, b) => a - b)[25],
        })
      } finally {
        decoder.dispose()
      }
    }
  },
  30_000,
)
