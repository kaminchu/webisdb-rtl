/**
 * Reed-Solomon RS(204,188) decoder for ISDB-T (ARIB STD-B31).
 *
 * Shortened from RS(255,239), t = 8, over GF(2^8) with primitive polynomial
 * x^8 + x^4 + x^3 + x^2 + 1 (0x11d). The generator polynomial has the
 * consecutive roots alpha^0 .. alpha^15.
 *
 * The 204-byte block is [188 data | 16 parity]. Decoding prepends the 51
 * implicit zero symbols of the shortened code, corrects up to eight byte
 * errors and returns the 188 data bytes, or null when uncorrectable.
 */

import type { RsBackend } from '../backend'

const PRIMITIVE = 0x11d
const FIELD_SIZE = 255
const PARITY_SYMBOLS = 16
const SHORTENED_PREFIX = 51
const RS_BLOCK_SIZE = 204
const RS_DATA_SIZE = 188

const EXP = new Uint8Array(FIELD_SIZE * 2)
const LOG = new Uint8Array(256)

{
  let x = 1
  for (let i = 0; i < FIELD_SIZE; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= PRIMITIVE
  }
  for (let i = FIELD_SIZE; i < EXP.length; i++) EXP[i] = EXP[i - FIELD_SIZE]
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

function gfDiv(a: number, b: number): number {
  if (a === 0) return 0
  return EXP[LOG[a] - LOG[b] + FIELD_SIZE]
}

function gfInv(a: number): number {
  return EXP[FIELD_SIZE - LOG[a]]
}

/** Generator polynomial g(x) = prod_{i=0..15} (x - alpha^i), low-to-high. */
export const RS_GENERATOR: readonly number[] = (() => {
  let g = [1]
  for (let i = 0; i < PARITY_SYMBOLS; i++) {
    const root = EXP[i]
    const next = Array.from<number>({ length: g.length + 1 }).fill(0)
    for (let j = 0; j < g.length; j++) {
      next[j] ^= gfMul(g[j], root)
      next[j + 1] ^= g[j]
    }
    g = next
  }
  return g
})()

function syndromes(full: Uint8Array): Uint8Array {
  const s = new Uint8Array(PARITY_SYMBOLS)
  for (let i = 0; i < PARITY_SYMBOLS; i++) {
    let acc = 0
    for (let j = 0; j < full.length; j++) {
      if (full[j] === 0) continue
      acc ^= gfMul(full[j], EXP[(i * (full.length - 1 - j)) % FIELD_SIZE])
    }
    s[i] = acc
  }
  return s
}

function allZero(values: Uint8Array): boolean {
  for (const v of values) if (v !== 0) return false
  return true
}

/** Berlekamp-Massey: error locator polynomial, low-to-high coefficients. */
function berlekampMassey(s: Uint8Array): number[] {
  let sigma = [1]
  let previous = [1]
  let L = 0
  let m = 1
  let scale = 1
  for (let n = 0; n < PARITY_SYMBOLS; n++) {
    let discrepancy = s[n]
    for (let i = 1; i <= L; i++) discrepancy ^= gfMul(sigma[i] ?? 0, s[n - i])
    if (discrepancy === 0) {
      m++
    } else if (2 * L <= n) {
      const saved = sigma.slice()
      const factor = gfDiv(discrepancy, scale)
      for (let i = 0; i < previous.length; i++) {
        const idx = i + m
        sigma[idx] = (sigma[idx] ?? 0) ^ gfMul(factor, previous[i])
      }
      L = n + 1 - L
      previous = saved
      scale = discrepancy
      m = 1
    } else {
      const factor = gfDiv(discrepancy, scale)
      for (let i = 0; i < previous.length; i++) {
        const idx = i + m
        sigma[idx] = (sigma[idx] ?? 0) ^ gfMul(factor, previous[i])
      }
      m++
    }
  }
  return sigma
}

function evalPoly(poly: ArrayLike<number>, x: number): number {
  let acc = 0
  for (let i = poly.length - 1; i >= 0; i--) acc = gfMul(acc, x) ^ (poly[i] ?? 0)
  return acc
}

/** Find error positions (full codeword indices, 0 = highest degree). */
function chienSearch(sigma: readonly number[]): number[] {
  const positions: number[] = []
  for (let j = 0; j < FIELD_SIZE; j++) {
    const root = EXP[(j + 1) % FIELD_SIZE]
    if (evalPoly(sigma, root) === 0) positions.push(j)
  }
  return positions
}

/** Forney algorithm: error magnitudes for the given full-codeword positions. */
function forney(s: Uint8Array, sigma: readonly number[], positions: readonly number[]): number[] {
  const omega = new Uint8Array(PARITY_SYMBOLS)
  for (let i = 0; i < PARITY_SYMBOLS; i++) {
    let acc = 0
    for (let j = 0; j <= i; j++) acc ^= gfMul(s[j], sigma[i - j] ?? 0)
    omega[i] = acc
  }
  const derivative: number[] = []
  for (let i = 1; i < sigma.length; i++) derivative[i - 1] = i % 2 === 1 ? sigma[i] : 0

  const magnitudes: number[] = []
  for (const j of positions) {
    const x = EXP[(((FIELD_SIZE - 1 - j) % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE]
    const xInv = gfInv(x)
    const numerator = gfMul(x, evalPoly(omega, xInv))
    const denominator = evalPoly(derivative, xInv)
    if (denominator === 0) return []
    magnitudes.push(gfDiv(numerator, denominator))
  }
  return magnitudes
}

/** Decode a 204-byte RS(204,188) codeword. Returns null if uncorrectable. */
export function rsDecode(block: Uint8Array): Uint8Array | null {
  if (block.length !== RS_BLOCK_SIZE) return null
  const full = new Uint8Array(FIELD_SIZE)
  full.set(block, SHORTENED_PREFIX)

  const s = syndromes(full)
  if (allZero(s)) return block.slice(0, RS_DATA_SIZE)

  const sigma = berlekampMassey(s)
  const positions = chienSearch(sigma)
  const degree = sigma.reduce((acc, v, i) => (i > 0 && v !== 0 ? i : acc), 0)
  if (positions.length === 0 || positions.length !== degree || positions.length > 8) return null

  const magnitudes = forney(s, sigma, positions)
  if (magnitudes.length !== positions.length) return null

  for (let i = 0; i < positions.length; i++) full[positions[i]] ^= magnitudes[i]

  if (!allZero(syndromes(full))) return null
  return full.slice(SHORTENED_PREFIX, SHORTENED_PREFIX + RS_DATA_SIZE)
}

/** TypeScript Reed-Solomon backend. */
export class TsRsBackend implements RsBackend {
  readonly name = 'ts-rs'

  decode(block: Uint8Array): Uint8Array | null {
    return rsDecode(block)
  }
}
