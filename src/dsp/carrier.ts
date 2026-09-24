/**
 * IQ / carrier helpers for the one-seg (center segment) receiver.
 *
 * The one-seg FFT size is the full ISDB-T FFT size / 8 and its sampling rate is
 * FFT_SAMPLING_HZ / 8 = 64/63 MHz, so the sub-carrier spacing is unchanged. The
 * center segment is centered on the channel center: after an FFT and fftshift the
 * `carriersPerSegment` carriers occupy bins [N/2 - carriers/2, N/2 + carriers/2).
 */

import { MODE_PARAMS, type TransmissionMode } from './isdbtParams'

export interface ComplexCarriers {
  re: Float32Array
  im: Float32Array
}

/** Convert interleaved U8 IQ (I,Q,I,Q,...) to complex float in [-1, 1). */
export function u8ToComplex(data: Uint8Array, out?: Float32Array): Float32Array {
  const dst = out ?? new Float32Array(data.length)
  const n = Math.min(dst.length, data.length)
  const scale = 1 / 127.5
  for (let i = 0; i < n; i++) dst[i] = (data[i] - 127.5) * scale
  return dst
}

/** In-place fftshift over the first `n` complex bins: swaps the two halves. */
export function fftShift(re: Float32Array, im: Float32Array, n: number): void {
  const half = n >> 1
  for (let i = 0; i < half; i++) {
    const j = i + half
    const tr = re[i]
    re[i] = re[j]
    re[j] = tr
    const ti = im[i]
    im[i] = im[j]
    im[j] = ti
  }
}

/** Segment-relative carrier index -> FFT bin (post-fftshift, DC at N/2). */
export function carrierToBin(carrier: number, mode: TransmissionMode): number {
  const { oneSegFftSize, carriersPerSegment } = MODE_PARAMS[mode]
  return oneSegFftSize / 2 - carriersPerSegment / 2 + carrier
}

/** FFT bin (post-fftshift, DC at N/2) -> segment-relative carrier index. */
export function binToCarrier(bin: number, mode: TransmissionMode): number {
  const { oneSegFftSize, carriersPerSegment } = MODE_PARAMS[mode]
  return bin - (oneSegFftSize / 2 - carriersPerSegment / 2)
}

/**
 * Extract the `carriersPerSegment` center-segment carriers from a one-seg FFT
 * output of length `oneSegFftSize`. The input is the raw FFT output; the shift
 * is applied implicitly through the bin mapping.
 */
export function extractOneSegCarriers(
  re: Float32Array,
  im: Float32Array,
  mode: TransmissionMode,
): ComplexCarriers {
  const { oneSegFftSize: n, carriersPerSegment: cps } = MODE_PARAMS[mode]
  const outRe = new Float32Array(cps)
  const outIm = new Float32Array(cps)
  const base = n / 2 - cps / 2
  for (let c = 0; c < cps; c++) {
    const bin = (base + c + n) % n
    outRe[c] = re[bin]
    outIm[c] = im[bin]
  }
  return { re: outRe, im: outIm }
}
