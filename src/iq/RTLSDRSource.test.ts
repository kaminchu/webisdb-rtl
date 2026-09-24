import { describe, expect, it } from 'vitest'
import { MockUsbTransport } from '../driver/rtlsdr/usbTransport'
import type { IQSourceState, IqChunk } from './IQSource'
import { RTLSDRSource } from './RTLSDRSource'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('RTLSDRSource', () => {
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
