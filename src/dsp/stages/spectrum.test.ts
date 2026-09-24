import { describe, expect, it } from 'vitest'
import { TsFftBackend } from './fft'
import { powerSpectrumDb } from './spectrum'

describe('powerSpectrumDb', () => {
  it('peaks at the fftshifted bin of a complex tone', () => {
    const n = 256
    const k0 = 30
    const samples = new Float32Array(2 * n)
    for (let i = 0; i < n; i++) {
      const ph = (2 * Math.PI * k0 * i) / n
      samples[2 * i] = Math.cos(ph)
      samples[2 * i + 1] = Math.sin(ph)
    }
    const out = powerSpectrumDb(samples, n, new TsFftBackend())
    let peak = 0
    let peakDb = -Infinity
    for (let i = 0; i < n; i++) {
      if (out[i] > peakDb) {
        peakDb = out[i]
        peak = i
      }
    }
    expect(peak).toBe((k0 + n / 2) % n)
  })

  it('returns fftSize values', () => {
    const out = powerSpectrumDb(new Float32Array(64), 32, new TsFftBackend())
    expect(out).toHaveLength(32)
  })
})
