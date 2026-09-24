/**
 * Fractional (rational) resampler for the one-seg front end.
 *
 * A windowed-sinc low-pass is evaluated on a fixed table of fractional phases and
 * applied as a polyphase FIR. The cutoff defaults to 450 kHz so the 64/63 MHz
 * one-seg band (centre segment, +/-216 carriers ~ +/-214 kHz) is preserved while
 * adjacent 6 MHz segments are rejected before decimating 1.2 MSps -> 64/63 MSps.
 *
 * The source position is tracked as an integer cursor plus a bounded fractional
 * phase, so the output is independent of the input chunking.
 */

const HALF_TAPS = 16
const PHASES = 256

function sinc(x: number): number {
  if (x === 0) return 1
  const px = Math.PI * x
  return Math.sin(px) / px
}

function buildTable(cutoffNorm: number): Float32Array {
  const taps = 2 * HALF_TAPS
  const table = new Float32Array(PHASES * taps)
  for (let ph = 0; ph < PHASES; ph++) {
    const frac = ph / PHASES
    let sum = 0
    for (let j = -(HALF_TAPS - 1); j <= HALF_TAPS; j++) {
      const t = j - frac
      const window = 0.54 + 0.46 * Math.cos((Math.PI * t) / HALF_TAPS)
      const value = 2 * cutoffNorm * sinc(2 * cutoffNorm * t) * window
      table[ph * taps + (j + HALF_TAPS - 1)] = value
      sum += value
    }
    const inv = sum !== 0 ? 1 / sum : 0
    for (let k = 0; k < taps; k++) table[ph * taps + k] *= inv
  }
  return table
}

export interface ResampledBlock {
  re: Float32Array
  im: Float32Array
}

export class FractionalResampler {
  private readonly stepInt: number
  private readonly stepFrac: number
  private readonly table: Float32Array
  private bufRe: Float32Array
  private bufIm: Float32Array
  private bufLen = 0
  private base = -HALF_TAPS
  private cursor = 0
  private phase = 0

  constructor(srcRate: number, dstRate: number, cutoffHz = 450_000) {
    if (srcRate <= 0 || dstRate <= 0) throw new Error('sample rates must be positive')
    const step = srcRate / dstRate
    this.stepInt = Math.floor(step)
    this.stepFrac = step - this.stepInt
    const cutoffNorm = Math.min(cutoffHz / srcRate, 0.4999)
    this.table = buildTable(cutoffNorm)
    this.bufRe = new Float32Array(4096)
    this.bufIm = new Float32Array(4096)
    this.reset()
  }

  reset(): void {
    this.bufRe.fill(0, 0, HALF_TAPS)
    this.bufIm.fill(0, 0, HALF_TAPS)
    this.bufLen = HALF_TAPS
    this.base = -HALF_TAPS
    this.cursor = 0
    this.phase = 0
  }

  process(re: Float32Array, im: Float32Array): ResampledBlock {
    this.append(re, im)
    const outRe: number[] = []
    const outIm: number[] = []
    const taps = 2 * HALF_TAPS
    for (;;) {
      const i0 = this.cursor - this.base
      if (i0 + HALF_TAPS >= this.bufLen) break
      let ph = Math.floor(this.phase * PHASES)
      if (ph >= PHASES) ph = PHASES - 1
      const base = i0 - (HALF_TAPS - 1)
      const off = ph * taps
      let sr = 0
      let si = 0
      for (let k = 0; k < taps; k++) {
        const coef = this.table[off + k]
        sr += this.bufRe[base + k] * coef
        si += this.bufIm[base + k] * coef
      }
      outRe.push(sr)
      outIm.push(si)
      this.phase += this.stepFrac
      this.cursor += this.stepInt
      if (this.phase >= 1) {
        this.phase -= 1
        this.cursor += 1
      }
    }

    const keepFrom = Math.max(0, this.cursor - this.base - (HALF_TAPS - 1))
    if (keepFrom > 0) {
      this.bufRe.copyWithin(0, keepFrom, this.bufLen)
      this.bufIm.copyWithin(0, keepFrom, this.bufLen)
      this.bufLen -= keepFrom
      this.base += keepFrom
    }
    return { re: Float32Array.from(outRe), im: Float32Array.from(outIm) }
  }

  private append(re: Float32Array, im: Float32Array): void {
    const need = this.bufLen + re.length
    if (need > this.bufRe.length) {
      let cap = this.bufRe.length || 1024
      while (cap < need) cap <<= 1
      const nr = new Float32Array(cap)
      nr.set(this.bufRe.subarray(0, this.bufLen))
      const ni = new Float32Array(cap)
      ni.set(this.bufIm.subarray(0, this.bufLen))
      this.bufRe = nr
      this.bufIm = ni
    }
    this.bufRe.set(re, this.bufLen)
    this.bufIm.set(im, this.bufLen)
    this.bufLen += re.length
  }
}
