import { describe, expect, it } from 'vitest'
import { MockUsbTransport } from './usbTransport'
import { identifyDevice } from './deviceProfile'

function handlerFor(responses: Record<number, number>): MockUsbTransport['controlInHandler'] {
  return (_request, value, _index, length) => {
    const byte = responses[value]
    if (byte === undefined) return new Uint8Array(length)
    return Uint8Array.of(byte)
  }
}

describe('identifyDevice', () => {
  it('detects an FC0013 generic dongle', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = handlerFor({ 0xc6: 0xa3 })
    const profile = await identifyDevice(transport)
    expect(profile.tuner).toBe('FC0013')
    expect(profile.model).toBe('Generic RTL2832U')
    expect(profile.zeroIf).toBe(true)
    expect(profile.i2cAddress).toBe(0xc6)
    expect(profile.ifFrequencyHz).toBe(0)
  })

  it('detects an R820T2 as an RTL-SDR Blog V3', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = handlerFor({ 0x34: 0x96 })
    const profile = await identifyDevice(transport)
    expect(profile.tuner).toBe('R820T2')
    expect(profile.model).toBe('RTL-SDR Blog V3')
    expect(profile.zeroIf).toBe(false)
    expect(profile.i2cAddress).toBe(0x34)
    expect(profile.ifFrequencyHz).toBe(3_570_000)
  })

  it('detects an R828D as an RTL-SDR Blog V4', async () => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = handlerFor({ 0x74: 0x96 })
    const profile = await identifyDevice(transport)
    expect(profile.tuner).toBe('R828D')
    expect(profile.model).toBe('RTL-SDR Blog V4')
    expect(profile.i2cAddress).toBe(0x74)
  })
})
