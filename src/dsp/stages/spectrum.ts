/**
 * Power spectrum for the UI spectrum display.
 *
 * Input is interleaved complex IQ (I,Q,I,Q,...) as produced by `u8ToComplex`.
 * A Hann window is applied, then a forward FFT; the output is fftshifted so DC is
 * at index fftSize/2 and expressed in dB.
 */

import type { FftBackend } from '../backend'

export function powerSpectrumDb(
  samples: Float32Array,
  fftSize: number,
  backend: FftBackend,
): Float32Array {
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  const avail = Math.min(fftSize, Math.floor(samples.length / 2))
  const denom = avail > 1 ? avail - 1 : 1
  for (let i = 0; i < avail; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom)
    re[i] = samples[2 * i] * w
    im[i] = samples[2 * i + 1] * w
  }
  backend.forward(re, im)

  const out = new Float32Array(fftSize)
  const half = fftSize >> 1
  const norm = 1 / fftSize
  for (let i = 0; i < fftSize; i++) {
    const p = (re[i] * re[i] + im[i] * im[i]) * norm
    out[(i + half) % fftSize] = 10 * Math.log10(p + 1e-12)
  }
  return out
}
