/**
 * Radix-2 iterative FFT (no external dependencies).
 *
 * `forward` uses sign -1, `inverse` uses sign +1 with 1/N scaling, so
 * `inverse(forward(x)) == x` and Parseval holds as sum|x|^2 = (1/N) sum|X|^2.
 */

import type { FftBackend } from '../backend'

function transform(re: Float32Array, im: Float32Array, sign: number): void {
  const n = re.length
  if (n <= 1) return

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let curR = 1
      let curI = 0
      for (let k = 0; k < half; k++) {
        const a = i + k
        const b = a + half
        const vR = re[b] * curR - im[b] * curI
        const vI = re[b] * curI + im[b] * curR
        re[b] = re[a] - vR
        im[b] = im[a] - vI
        re[a] += vR
        im[a] += vI
        const nR = curR * wr - curI * wi
        curI = curR * wi + curI * wr
        curR = nR
      }
    }
  }
}

/** In-place forward FFT (sign -1). */
export function fftForward(re: Float32Array, im: Float32Array): void {
  transform(re, im, -1)
}

/** In-place inverse FFT (sign +1) with 1/N scaling. */
export function fftInverse(re: Float32Array, im: Float32Array): void {
  const n = re.length
  transform(re, im, 1)
  const scale = 1 / n
  for (let i = 0; i < n; i++) {
    re[i] *= scale
    im[i] *= scale
  }
}

export class TsFftBackend implements FftBackend {
  readonly name = 'ts-radix2'

  forward(re: Float32Array, im: Float32Array): void {
    fftForward(re, im)
  }

  inverse(re: Float32Array, im: Float32Array): void {
    fftInverse(re, im)
  }
}
