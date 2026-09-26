import { describe, expect, it } from 'vitest'
import type { IqChunk } from './IQSource'
import { deliverIqChunk } from './IQSource'

function chunk(data: IqChunk['data']): IqChunk {
  return {
    data,
    format: data instanceof Float32Array ? 'f32' : data instanceof Int8Array ? 'i8' : 'u8',
    sampleRate: 1_200_000,
    centerFrequency: 0,
    sequence: 0,
    timestamp: 0,
  }
}

describe('deliverIqChunk', () => {
  it('hands a sole transfer subscriber the original buffer', () => {
    const data = Uint8Array.from([1, 2, 3, 4])
    const received: IqChunk[] = []
    deliverIqChunk(new Map([[(c) => received.push(c), true]]), chunk(data))
    expect(received[0].data).toBe(data)
  })

  it('copies for a transfer subscriber when other subscribers exist', () => {
    const data = Uint8Array.from([1, 2, 3, 4])
    const transferred: IqChunk[] = []
    const shared: IqChunk[] = []
    deliverIqChunk(
      new Map([
        [(c) => transferred.push(c), true],
        [(c) => shared.push(c), false],
      ]),
      chunk(data),
    )
    expect(shared[0].data).toBe(data)
    expect(transferred[0].data).not.toBe(data)
    expect(Array.from(transferred[0].data)).toEqual([1, 2, 3, 4])
  })

  it('copies for a transfer subscriber when the chunk is an offset view', () => {
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 4, 9, 9])
    const data = backing.subarray(2, 6)
    const received: IqChunk[] = []
    deliverIqChunk(new Map([[(c) => received.push(c), true]]), chunk(data))
    expect(received[0].data).not.toBe(data)
    expect(received[0].data.buffer).not.toBe(backing.buffer)
    expect(Array.from(received[0].data)).toEqual([1, 2, 3, 4])
  })

  it('leaves non-transfer subscribers on the original buffer', () => {
    const data = Uint8Array.from([1, 2, 3, 4])
    const received: IqChunk[] = []
    deliverIqChunk(new Map([[(c) => received.push(c), false]]), chunk(data))
    expect(received[0].data).toBe(data)
  })
})
