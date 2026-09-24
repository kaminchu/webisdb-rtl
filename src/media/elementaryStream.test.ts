import { describe, expect, it } from 'vitest'
import { AdtsAssembler, splitAvcAccessUnits } from './elementaryStream'

function adts(payload: number[]): Uint8Array {
  const length = payload.length + 7
  return Uint8Array.from([
    0xff,
    0xf9,
    0x58,
    0x80 | (length >> 11),
    (length >> 3) & 255,
    ((length & 7) << 5) | 0x1f,
    0xfc,
    ...payload,
  ])
}

describe('ADTS framing', () => {
  it('recovers sync and assembles AAC frames crossing PES boundaries', () => {
    const first = adts([1, 2, 3, 4])
    const second = adts([5, 6, 7])
    const parser = new AdtsAssembler()
    expect(parser.push(Uint8Array.from([12, 34, ...first.slice(0, 9)]), 1000)).toEqual([])
    const frames = parser.push(Uint8Array.from([...first.slice(9), ...second]), 50000)
    expect(frames.map((frame) => frame.data)).toEqual([first, second])
    expect(frames.map((frame) => frame.timestamp)).toEqual([1000, 50000])
    expect(frames[0]).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 24000, numberOfChannels: 2 })
  })

  it('advances timestamps per AAC frame and discards buffered data on retune', () => {
    const frame = adts([1, 2])
    const parser = new AdtsAssembler()
    const frames = parser.push(Uint8Array.from([...frame, ...frame]), 0)
    expect(frames[1].timestamp).toBeCloseTo((1024 / 24000) * 1_000_000)
    parser.push(frame.slice(0, 8), 0)
    parser.reset()
    expect(parser.push(frame, 9000)[0].timestamp).toBe(9000)
  })
})

it('splits a multi-picture AVC PES at AUDs while retaining SPS/PPS and slices', () => {
  const first = [0, 0, 0, 1, 9, 16, 0, 0, 1, 0x67, 66, 0, 0, 1, 0x68, 1, 0, 0, 1, 0x65, 99]
  const second = [0, 0, 1, 9, 48, 0, 0, 1, 0x41, 88]
  const units = splitAvcAccessUnits(Uint8Array.from([...first, ...second]))
  expect(units.map((unit) => [...unit])).toEqual([first, second])
})
