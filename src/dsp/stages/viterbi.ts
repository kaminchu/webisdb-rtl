/**
 * Convolutional decoder for ISDB-T (ARIB STD-B31).
 *
 * Constraint length K = 7, generator polynomials G1 = 171 octal and
 * G2 = 133 octal (the NASA standard code). The decoder accepts the punctured
 * bit stream and depunctures it internally: punctured positions become
 * erasures (value 2), which contribute nothing to the Hamming metric.
 *
 * The encoder convention used here is `reg = ((reg << 1) | input) & 0x7f`
 * with output bit 1 = parity(reg & G1), bit 2 = parity(reg & G2). The ARIB
 * generator polynomials 171/133 octal are drawn with the input entering the
 * leftmost stage; with this shift-left register they become the bit-reversed
 * taps 0x4f and 0x6d.
 */

import type { ViterbiBackend, ViterbiRate } from '../backend'

const G1 = 0x4f
const G2 = 0x6d
const NUM_STATES = 64
const ERASURE = 2
const TRACEBACK = 128

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

/**
 * Streaming soft-decision Viterbi decoder.
 *
 * Mirrors the reference register-exchange decoder: the metric is a correlation
 * (maximised), positive soft values mean label bit 0, and each decoded bit is
 * emitted after a fixed `TRACEBACK`-step delay. Feed one depunctured-position
 * soft value at a time via `feedSoft`; decoded bytes are delivered to `onByte`.
 */
export class StreamingViterbi {
  private readonly rate: ViterbiRate
  private readonly onByte: (byte: number) => void
  private readonly metrics = new Float64Array(NUM_STATES)
  private readonly decisions = new Uint8Array(TRACEBACK * NUM_STATES)
  private readonly next = new Float64Array(NUM_STATES)
  private readonly signA = Int8Array.from({ length: NUM_STATES }, (_, state) =>
    parity(state & G1) === 0 ? 1 : -1,
  )
  private readonly signB = Int8Array.from({ length: NUM_STATES }, (_, state) =>
    parity(state & G2) === 0 ? 1 : -1,
  )
  private position = 0
  private pair: number[] = []
  private stepCount = 0
  private byte = 0
  private bits = 0

  constructor(rate: ViterbiRate, onByte: (byte: number) => void) {
    this.rate = rate
    this.onByte = onByte
  }

  reset(): void {
    this.metrics.fill(0)
    this.decisions.fill(0)
    this.position = 0
    this.pair = []
    this.stepCount = 0
    this.byte = 0
    this.bits = 0
  }

  /** Feed one soft value (positive means bit 0, 0 means erasure). */
  feedSoft(soft: number): void {
    const pattern = PUNCTURE_PATTERNS[this.rate]
    for (;;) {
      const keep = pattern[this.position]
      this.position = (this.position + 1) % pattern.length
      this.pair.push(keep === 1 ? soft : 0)
      if (this.pair.length === 2) {
        const a = this.pair[0]
        const b = this.pair[1]
        this.pair = []
        this.step(a, b)
      }
      if (keep === 1) break
    }
  }

  private step(a: number, b: number): void {
    const metrics = this.metrics
    const next = this.next
    const slot = (this.stepCount % TRACEBACK) * NUM_STATES
    for (let state = 0; state < NUM_STATES; state++) {
      const pred = state >> 1
      const branch = this.signA[state] * a + this.signB[state] * b
      const lo = metrics[pred] + branch
      const hi = metrics[pred | 32] - branch
      if (lo >= hi) {
        next[state] = lo
        this.decisions[slot + state] = pred
      } else {
        next[state] = hi
        this.decisions[slot + state] = pred | 32
      }
    }
    let best = 0
    for (let s = 1; s < NUM_STATES; s++) if (next[s] > next[best]) best = s
    const max = next[best]
    for (let s = 0; s < NUM_STATES; s++) metrics[s] = next[s] - max
    this.stepCount++
    if (this.stepCount < TRACEBACK) return

    let s = best
    for (let j = 0; j < TRACEBACK - 1; j++) {
      const k = this.stepCount - j
      const decisionSlot = (((k - 1) % TRACEBACK) + TRACEBACK) % TRACEBACK
      s = this.decisions[decisionSlot * NUM_STATES + s]
    }
    this.byte = ((this.byte << 1) | (s & 1)) & 0xff
    this.bits++
    if (this.bits === 8) {
      this.bits = 0
      this.onByte(this.byte)
    }
  }
}
