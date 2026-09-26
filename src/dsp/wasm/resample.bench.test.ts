import { it } from 'vitest'
import { ONESEG_SAMPLING_HZ } from '../isdbtParams'
import { WasmDcRemoval, WasmFractionalResampler, WasmU8Decimator } from './resample'

function raw(rate: number): Uint8Array {
  const data = new Uint8Array(Math.floor(rate / 10) * 2)
  for (let i = 0; i < data.length; i++) data[i] = (i * 73 + (i >>> 8)) & 255
  return data
}

it.skipIf(process.env.RUN_FRONTEND_BENCHMARK !== '1')(
  'benchmarks 100 ms of U8 RF including host copies',
  () => {
    const genericRate = 1_200_000
    const generic = raw(genericRate)
    const isdbt = raw(ONESEG_SAMPLING_HZ * 2)
    const re = new Float32Array(generic.length / 2)
    const im = new Float32Array(re.length)
    const dc = new WasmDcRemoval()
    const resampler = new WasmFractionalResampler(genericRate, ONESEG_SAMPLING_HZ)
    const decimator = new WasmU8Decimator(2)

    const genericRun = () => {
      const scale = 1 / 127.5
      for (let i = 0; i < re.length; i++) {
        re[i] = (generic[2 * i] - 127.5) * scale
        im[i] = (generic[2 * i + 1] - 127.5) * scale
      }
      dc.process(re, im)
      resampler.process(re, im)
    }

    const isdbtRun = () => {
      decimator.process(isdbt)
    }
    try {
      for (let i = 0; i < 20; i++) {
        genericRun()
        isdbtRun()
      }
      const timings = [[], []] as number[][]
      const runs = [genericRun, isdbtRun]
      for (let i = 0; i < 100; i++) {
        for (const j of i % 2 === 0 ? [0, 1] : [1, 0]) {
          const start = performance.now()
          runs[j]()
          timings[j].push(performance.now() - start)
        }
      }
      const [genericMs, isdbtMs] = timings.map((values) => values.toSorted((a, b) => a - b)[50])
      console.log({ genericMs, isdbtMs, speedup: genericMs / isdbtMs })
    } finally {
      dc.dispose()
      resampler.dispose()
      decimator.dispose()
    }
  },
)
