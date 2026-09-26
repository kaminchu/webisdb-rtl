import { describe, expect, it } from 'vitest'
import { OfdmSynchronizer } from '../stages/ofdmSync'
import { GpuSynchronizer, type SyncCorrelator } from './synchronizer'

class TsCorrelator implements SyncCorrelator {
  re: Float32Array = new Float32Array(0)
  im: Float32Array = new Float32Array(0)
  private readonly n: number
  private readonly cp: number

  constructor(n: number, cp: number) {
    this.n = n
    this.cp = cp
  }

  prepare(re: Float32Array, im: Float32Array): void {
    this.re = re
    this.im = im
  }

  async correlate(start: number, count: number): Promise<Float32Array> {
    const out = new Float32Array(count * 4)
    for (let j = 0; j < count; j++) {
      const s = start + j
      let gr = 0
      let gi = 0
      let phi = 0
      for (let i = 0; i < this.cp; i++) {
        const a = s + i
        const b = a + this.n
        const ar = this.re[a]
        const ai = this.im[a]
        const br = this.re[b]
        const bi = this.im[b]
        gr += ar * br + ai * bi
        gi += ai * br - ar * bi
        phi += 0.5 * (ar * ar + ai * ai) + 0.5 * (br * br + bi * bi)
      }
      out[j * 4] = Math.hypot(gr, gi) - 0.5 * phi
      out[j * 4 + 1] = gr
      out[j * 4 + 2] = gi
      out[j * 4 + 3] = phi
    }
    return out
  }

  dispose(): void {}
}

function buildSignal(n: number, cp: number, symbols: number, seed: number) {
  const re = new Float32Array(symbols * (n + cp))
  const im = new Float32Array(symbols * (n + cp))
  let state = seed >>> 0
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000 - 0.5
  }
  for (let s = 0; s < symbols; s++) {
    const bodyRe = new Float32Array(n)
    const bodyIm = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      bodyRe[i] = rand()
      bodyIm[i] = rand()
    }
    const base = s * (n + cp)
    for (let i = 0; i < cp; i++) {
      re[base + i] = bodyRe[n - cp + i]
      im[base + i] = bodyIm[n - cp + i]
    }
    for (let i = 0; i < n; i++) {
      re[base + cp + i] = bodyRe[i]
      im[base + cp + i] = bodyIm[i]
    }
  }
  return { re, im }
}

async function feedGpu(chunks: { re: Float32Array; im: Float32Array }[], sync: GpuSynchronizer) {
  const starts: number[] = []
  for (const chunk of chunks) {
    const result = await sync.process(chunk.re, chunk.im)
    starts.push(...result.symbolStarts)
  }
  return starts
}

function feedReference(chunks: { re: Float32Array; im: Float32Array }[], sync: OfdmSynchronizer) {
  const starts: number[] = []
  for (const chunk of chunks) {
    starts.push(...sync.process(chunk.re, chunk.im).symbolStarts)
  }
  return starts
}

function chunkSignal(re: Float32Array, im: Float32Array, size: number) {
  const chunks: { re: Float32Array; im: Float32Array }[] = []
  for (let offset = 0; offset < re.length; offset += size) {
    chunks.push({
      re: re.subarray(offset, Math.min(offset + size, re.length)),
      im: im.subarray(offset, Math.min(offset + size, im.length)),
    })
  }
  return chunks
}

describe('GpuSynchronizer', () => {
  it('matches the TypeScript reference symbol starts', async () => {
    const n = 64
    const gi = 4
    const cp = n / gi
    const { re, im } = buildSignal(n, cp, 40, 0x1234)
    const chunks = chunkSignal(re, im, 37)

    const reference = new OfdmSynchronizer(n, gi, 1_000_000, true)
    const gpu = new GpuSynchronizer(new TsCorrelator(n, cp), n, gi, 1_000_000, true)
    try {
      const expected = feedReference(chunks, reference)
      const actual = await feedGpu(chunks, gpu)
      expect(actual.length).toBeGreaterThan(10)
      expect(actual).toEqual(expected)
    } finally {
      gpu.dispose()
    }
  })

  it('reports no starts before enough samples are buffered', async () => {
    const n = 64
    const gi = 4
    const { re, im } = buildSignal(n, cpOf(n, gi), 1, 7)
    const gpu = new GpuSynchronizer(new TsCorrelator(n, cpOf(n, gi)), n, gi, 1_000_000, true)
    try {
      const result = await gpu.process(re.subarray(0, 10), im.subarray(0, 10))
      expect(result.symbolStarts).toEqual([])
    } finally {
      gpu.dispose()
    }
  })
})

function cpOf(n: number, gi: number): number {
  return Math.floor(n / gi)
}
