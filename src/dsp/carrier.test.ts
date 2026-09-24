import { describe, expect, it } from 'vitest'
import { MODE_PARAMS } from './isdbtParams'
import { binToCarrier, carrierToBin, extractOneSegCarriers, fftShift, u8ToComplex } from './carrier'
import { TsFftBackend } from './stages/fft'

describe('u8ToComplex', () => {
  it('maps the U8 range to [-1, 1)', () => {
    const out = u8ToComplex(Uint8Array.from([0, 127, 128, 255]))
    expect(out[0]).toBeCloseTo(-1, 6)
    expect(out[1]).toBeCloseTo(-0.5 / 127.5, 6)
    expect(out[2]).toBeCloseTo(0.5 / 127.5, 6)
    expect(out[3]).toBeCloseTo(1, 6)
  })

  it('honours an output buffer', () => {
    const buf = new Float32Array(4)
    const out = u8ToComplex(Uint8Array.from([0, 127, 128, 255]), buf)
    expect(out).toBe(buf)
  })
})

describe('fftShift', () => {
  it('swaps the two halves', () => {
    const re = Float32Array.from([1, 2, 3, 4])
    const im = Float32Array.from([5, 6, 7, 8])
    fftShift(re, im, 4)
    expect(Array.from(re)).toEqual([3, 4, 1, 2])
    expect(Array.from(im)).toEqual([7, 8, 5, 6])
  })
})

describe('carrier/bin mapping', () => {
  it('round-trips and spans the center segment', () => {
    for (const mode of [1, 2, 3] as const) {
      const cps = MODE_PARAMS[mode].carriersPerSegment
      expect(carrierToBin(0, mode)).toBe(MODE_PARAMS[mode].oneSegFftSize / 2 - cps / 2)
      expect(carrierToBin(cps - 1, mode)).toBe(MODE_PARAMS[mode].oneSegFftSize / 2 + cps / 2 - 1)
      for (const c of [0, 1, cps >> 1, cps - 1]) {
        expect(binToCarrier(carrierToBin(c, mode), mode)).toBe(c)
      }
    }
  })
})

describe('extractOneSegCarriers', () => {
  it('places a tone at its carrier index', () => {
    const mode = 3 as const
    const n = MODE_PARAMS[mode].oneSegFftSize
    const c0 = 100
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    const bin = carrierToBin(c0, mode)
    for (let t = 0; t < n; t++) {
      const ph = (2 * Math.PI * bin * t) / n
      re[t] = Math.cos(ph)
      im[t] = Math.sin(ph)
    }
    const backend = new TsFftBackend()
    backend.forward(re, im)
    const carriers = extractOneSegCarriers(re, im, mode)

    let peak = 0
    let peakMag = -1
    for (let c = 0; c < carriers.re.length; c++) {
      const mag = Math.hypot(carriers.re[c], carriers.im[c])
      if (mag > peakMag) {
        peakMag = mag
        peak = c
      }
    }
    expect(peak).toBe(c0)
  })
})
