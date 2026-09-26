import { describe, expect, it } from 'vitest'
import { MockUsbTransport } from '../driver/rtlsdr/usbTransport'
import type { IQSourceState, IqChunk } from './IQSource'
import { RTLSDRSource } from './RTLSDRSource'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('RTLSDRSource', () => {
  it('queues bulk reads ahead of consumption and replenishes before notifying listeners', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = (_request, _value, _index, length) =>
      new Uint8Array(length).fill(0xa3)
    const source = new RTLSDRSource(transport)
    const readCount = () =>
      transport.transfers.filter((transfer) => transfer.type === 'bulkIn').length
    const observed: number[] = []
    source.onSamples(() => observed.push(readCount()))
    await source.open()
    await source.start()
    expect(readCount()).toBe(8)
    transport.pushBulk(Uint8Array.of(1, 2))
    await tick()
    expect(observed).toEqual([9])
    const stopped = source.stop()
    transport.releasePendingBulk()
    await stopped
    await source.close()
  })

  it('emits bulk buffers as U8 chunks and stops cleanly', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = (_request, _value, _index, length) =>
      new Uint8Array(length).fill(0xa3)

    const source = new RTLSDRSource(transport, {
      sampleRate: 1_200_000,
      centerFrequency: 509_142_857,
    })
    const states: IQSourceState[] = []
    const chunks: IqChunk[] = []
    source.onStateChange((state) => states.push(state))
    source.onSamples((chunk) => chunks.push(chunk))

    await source.open()
    expect(source.state).toBe('open')
    expect(source.descriptor.label).toBe('Generic RTL2832U / FC0013')

    transport.pushBulk(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))
    transport.pushBulk(Uint8Array.from([10, 11, 12, 13]))
    await source.start()
    expect(source.state).toBe('running')

    await tick()
    expect(chunks).toHaveLength(2)
    expect(chunks[0].format).toBe('u8')
    expect(chunks[0].data).toHaveLength(8)
    expect(chunks[0].sequence).toBe(0)
    expect(chunks[1].data).toHaveLength(4)
    expect(chunks[1].sequence).toBe(1)
    expect(states).toContain('opening')
    expect(states).toContain('starting')

    const stopping = source.stop()
    transport.releasePendingBulk()
    await stopping
    expect(source.state).toBe('open')

    transport.pushBulk(Uint8Array.of(99))
    await tick()
    expect(chunks).toHaveLength(2)
  })

  it('hands the bulk buffer to a sole transfer subscriber without copying', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = (_request, _value, _index, length) =>
      new Uint8Array(length).fill(0xa3)
    const source = new RTLSDRSource(transport)
    const transferred: IqChunk[] = []
    source.onSamples((chunk) => transferred.push(chunk), { transfer: true })
    await source.open()
    const buffer = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
    transport.pushBulk(buffer)
    await source.start()
    await tick()

    expect(transferred).toHaveLength(1)
    expect(transferred[0].data).toBe(buffer)

    const stopping = source.stop()
    transport.releasePendingBulk()
    await stopping
    await source.close()
  })

  it('copies for a transfer subscriber when another subscriber is attached', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = (_request, _value, _index, length) =>
      new Uint8Array(length).fill(0xa3)
    const source = new RTLSDRSource(transport)
    const transferred: IqChunk[] = []
    const shared: IqChunk[] = []
    source.onSamples((chunk) => transferred.push(chunk), { transfer: true })
    source.onSamples((chunk) => shared.push(chunk))
    await source.open()
    const buffer = Uint8Array.from([1, 2, 3, 4])
    transport.pushBulk(buffer)
    await source.start()
    await tick()

    expect(shared[0].data).toBe(buffer)
    expect(transferred[0].data).not.toBe(buffer)
    expect(Array.from(transferred[0].data)).toEqual([1, 2, 3, 4])

    const stopping = source.stop()
    transport.releasePendingBulk()
    await stopping
    await source.close()
  })

  it('recovers from a transient bulk transfer failure', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = (_request, _value, _index, length) =>
      new Uint8Array(length).fill(0xa3)

    const source = new RTLSDRSource(transport)
    const chunks: IqChunk[] = []
    source.onSamples((chunk) => chunks.push(chunk))
    await source.open()
    await source.start()

    transport.failNextBulk(1)
    for (let i = 0; i < 8; i++) transport.pushBulk(Uint8Array.of(1, 2, 3, 4))
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(source.state).toBe('running')
    expect(chunks.length).toBeGreaterThan(0)

    const stopping = source.stop()
    transport.releasePendingBulk()
    await stopping
    await source.close()
  })

  it('stops with an error after repeated bulk transfer failures', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = (_request, _value, _index, length) =>
      new Uint8Array(length).fill(0xa3)

    const source = new RTLSDRSource(transport)
    await source.open()
    transport.failNextBulk(100)
    await source.start()

    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(source.state).toBe('error')
    await source.close()
  })

  it('reports an error state when the device disconnects', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = (_request, _value, _index, length) =>
      new Uint8Array(length).fill(0xa3)

    const source = new RTLSDRSource(transport)
    const states: IQSourceState[] = []
    source.onStateChange((state) => states.push(state))
    await source.open()
    await source.start()

    transport.emitDisconnect()
    expect(source.state).toBe('error')
    expect(states).toContain('error')

    transport.releasePendingBulk()
  })
})
