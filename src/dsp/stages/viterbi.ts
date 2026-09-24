/**
 * Convolutional decoder for ISDB-T (ARIB STD-B31).
 *
 * Constraint length K = 7, generator polynomials G1 = 171 octal and
 * G2 = 133 octal (the NASA standard code). The decoder accepts the punctured
 * bit stream and depunctures it internally: punctured positions become
 * erasures (value 2), which contribute nothing to the Hamming metric.
 *
 * The encoder convention used here is `reg = ((reg << 1) | input) & 0x7f`
 * with output bit 1 = parity(reg & G1), bit 2 = parity(reg & G2). A test-side
 * encoder must use the same convention.
 */

import type { ViterbiBackend, ViterbiRate } from '../backend'

const G1 = 0o171
const G2 = 0o133
const NUM_STATES = 64
const ERASURE = 2

/** Depuncturing patterns (1 = transmitted, 0 = punctured), one period each. */
export const PUNCTURE_PATTERNS: Record<ViterbiRate, readonly number[]> = {
  '1/2': [1, 1],
  '2/3': [1, 1, 0, 1],
  '3/4': [1, 1, 0, 1, 1, 0],
  '5/6': [1, 1, 0, 1, 1, 0, 0, 1, 1, 0],
  '7/8': [1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0],
}

/** Expand a punctured bit stream into the mother-code stream with erasures. */
export function depuncture(input: Uint8Array, rate: ViterbiRate): Uint8Array {
  const pattern = PUNCTURE_PATTERNS[rate]
  const period = pattern.length
  const out: number[] = []
  let pi = 0
  for (let i = 0; i < input.length; i++) {
    while (pattern[pi % period] === 0) {
      out.push(ERASURE)
      pi++
    }
    out.push(input[i] & 1)
    pi++
  }
  while (out.length % 2 !== 0) {
    out.push(ERASURE)
  }
  return Uint8Array.from(out)
}

/** Expand a punctured soft stream into the mother stream, 0 = erasure. */
export function depunctureSoft(input: Int8Array, rate: ViterbiRate): Int8Array {
  const pattern = PUNCTURE_PATTERNS[rate]
  const period = pattern.length
  const out: number[] = []
  let pi = 0
  for (let i = 0; i < input.length; i++) {
    while (pattern[pi % period] === 0) {
      out.push(0)
      pi++
    }
    out.push(input[i])
    pi++
  }
  while (out.length % 2 !== 0) out.push(0)
  return Int8Array.from(out)
}

function parity(x: number): number {
  x ^= x >>> 16
  x ^= x >>> 8
  x ^= x >>> 4
  x &= 0xf
  return (0x6996 >>> x) & 1
}

function branchOutput(state: number, input: number): [number, number] {
  const reg = (state << 1) | input
  return [parity(reg & G1), parity(reg & G2)]
}

function hamming(received: number, expected: number): number {
  if (received === ERASURE) return 0
  return received === expected ? 0 : 1
}

/** TypeScript hard-decision Viterbi backend. */
export class TsViterbiBackend implements ViterbiBackend {
  readonly name = 'ts-viterbi'

  decode(input: Uint8Array, rate: ViterbiRate, terminate: boolean): Uint8Array {
    const mother = depuncture(input, rate)
    const steps = mother.length >>> 1
    if (steps === 0) return new Uint8Array(0)

    let metrics = new Float64Array(NUM_STATES).fill(Infinity)
    metrics[0] = 0
    const decisions = new Uint8Array(steps * NUM_STATES)

    for (let t = 0; t < steps; t++) {
      const r1 = mother[2 * t]
      const r2 = mother[2 * t + 1]
      const next = new Float64Array(NUM_STATES).fill(Infinity)
      const base = t * NUM_STATES
      for (let s = 0; s < NUM_STATES; s++) {
        const metric = metrics[s]
        if (metric === Infinity) continue
        for (let u = 0; u < 2; u++) {
          const [o1, o2] = branchOutput(s, u)
          const cost = metric + hamming(r1, o1) + hamming(r2, o2)
          const ns = ((s << 1) | u) & (NUM_STATES - 1)
          if (cost < next[ns]) {
            next[ns] = cost
            decisions[base + ns] = s
          }
        }
      }
      metrics = next
    }

    let state = 0
    if (!terminate) {
      let best = Infinity
      for (let s = 0; s < NUM_STATES; s++) {
        if (metrics[s] < best) {
          best = metrics[s]
          state = s
        }
      }
    }

    const outputLength = terminate ? steps - 6 : steps
    const out = new Uint8Array(Math.max(0, outputLength))
    let current = state
    for (let t = steps - 1; t >= 0; t--) {
      if (t < outputLength) out[t] = current & 1
      current = decisions[t * NUM_STATES + current]
    }
    return out
  }

  /** Soft-decision decode: input soft values, positive means bit 0. */
  decodeSoft(input: Int8Array, rate: ViterbiRate, terminate: boolean): Uint8Array {
    const mother = depunctureSoft(input, rate)
    const steps = mother.length >>> 1
    if (steps === 0) return new Uint8Array(0)

    let metrics = new Float64Array(NUM_STATES).fill(Infinity)
    metrics[0] = 0
    const decisions = new Uint8Array(steps * NUM_STATES)

    for (let t = 0; t < steps; t++) {
      const s1 = mother[2 * t]
      const s2 = mother[2 * t + 1]
      const next = new Float64Array(NUM_STATES).fill(Infinity)
      const base = t * NUM_STATES
      for (let s = 0; s < NUM_STATES; s++) {
        const metric = metrics[s]
        if (metric === Infinity) continue
        for (let u = 0; u < 2; u++) {
          const [o1, o2] = branchOutput(s, u)
          const cost = metric - s1 * (o1 ? -1 : 1) - s2 * (o2 ? -1 : 1)
          const ns = ((s << 1) | u) & (NUM_STATES - 1)
          if (cost < next[ns]) {
            next[ns] = cost
            decisions[base + ns] = s
          }
        }
      }
      metrics = next
    }

    let state = 0
    if (!terminate) {
      let best = Infinity
      for (let s = 0; s < NUM_STATES; s++) {
        if (metrics[s] < best) {
          best = metrics[s]
          state = s
        }
      }
    }

    const outputLength = terminate ? steps - 6 : steps
    const out = new Uint8Array(Math.max(0, outputLength))
    let current = state
    for (let t = steps - 1; t >= 0; t--) {
      if (t < outputLength) out[t] = current & 1
      current = decisions[t * NUM_STATES + current]
    }
    return out
  }
}

/** Encode one input bit with the K=7 mother code (test and transmit helper). */
export function convolutionalEncodeBit(
  state: number,
  input: number,
): {
  state: number
  outputs: [number, number]
} {
  const reg = (state << 1) | (input & 1)
  return { state: reg & (NUM_STATES - 1), outputs: branchOutput(state, input & 1) }
}
