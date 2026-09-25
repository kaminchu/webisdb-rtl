import { describe, expect, it } from 'vitest'
import type { TmccInfo } from '../../models/tmcc'
import type { TransmissionMode } from '../isdbtParams'
import { TmccDecoder } from '../stages/tmcc'
import { WasmTmccDecoder } from './tmcc'

function makeFrame(): Uint8Array {
  return Uint8Array.from(
    '001101011110111000000111101001001011000101101001011001111111111111100100101100010110100101100111111111111111111111111111100101011111010000001100111001111101011100111001011011011101010001111100010100101100',
    Number,
  )
}

function encodeDbpsk(
  frameBits: Uint8Array,
  producedBits: number,
): { re: Float32Array; im: Float32Array } {
  const count = producedBits + 1
  const re = new Float32Array(count)
  const im = new Float32Array(count)
  let phase = 0
  re[0] = 1
  for (let i = 0; i < producedBits; i++) {
    if (frameBits[i % frameBits.length] === 1) phase += Math.PI
    re[i + 1] = Math.cos(phase)
    im[i + 1] = Math.sin(phase)
  }
  return { re, im }
}

function snapshot(info: TmccInfo): unknown {
  return {
    locked: info.locked,
    mode: info.mode,
    gi: info.guardIntervalRatio,
    partial: info.partialReception,
    system: info.systemDescriptor,
    layers: info.layers,
    frames: info.frameCount,
  }
}

function runDifferential(
  stream: { re: Float32Array; im: Float32Array },
  mode: TransmissionMode,
  gi: number,
): TmccInfo {
  const reference = new TmccDecoder(mode, gi)
  const wasm = new WasmTmccDecoder(mode, gi)
  let info: TmccInfo | undefined
  for (let i = 0; i < stream.re.length; i++) {
    const re = stream.re.subarray(i, i + 1)
    const im = stream.im.subarray(i, i + 1)
    const expected = reference.push(re, im)
    const actual = wasm.push(re, im)
    expect(snapshot(actual), `step ${i}`).toEqual(snapshot(expected))
    info = actual
  }
  expect(wasm.frameStartSymbol).toBe(reference.frameStartSymbol)
  wasm.dispose()
  return info!
}

describe('WasmTmccDecoder', () => {
  it('matches the reference while locking after two frames', () => {
    const info = runDifferential(encodeDbpsk(makeFrame(), 612), 1, 8)
    expect(info.locked).toBe(true)
    expect(info.mode).toBe(1)
    expect(info.layers.A?.segments).toBe(1)
  })

  it('matches the reference across alternating even/odd sync words', () => {
    const even = makeFrame()
    const odd = even.slice()
    for (let i = 0; i < 16; i++) odd[i] ^= 1
    const pair = Uint8Array.from([...even, ...odd])
    const info = runDifferential(encodeDbpsk(pair, 2040), 1, 8)
    expect(info.locked).toBe(true)
    expect(info.frameCount).toBeGreaterThanOrEqual(9)
  })

  it('matches the reference for invalid DSC parity', () => {
    const frame = makeFrame()
    frame[125] ^= 1
    const info = runDifferential(encodeDbpsk(frame, 1020), 1, 8)
    expect(info.locked).toBe(false)
  })
})
