import { describe, expect, it } from 'vitest'
import { MockUsbTransport } from '../usbTransport'
import { Rtl2832u } from '../rtl2832u'
import { R82xxTuner, R82XX_INIT_ARRAY, r82xxGainIndex } from './r82xx'

const I2C_WRITE_INDEX = (6 << 8) | 0x10
const I2C_ADDRESS = 0x34

function i2cWrites(mock: MockUsbTransport, address: number): Uint8Array[] {
  return mock.transfers
    .filter((t) => t.type === 'controlOut' && t.index === I2C_WRITE_INDEX && t.value === address)
    .map((t) => t.data ?? new Uint8Array())
}

function installR820THandler(mock: MockUsbTransport): void {
  mock.controlInHandler = (_request, value, _index, length) => {
    if (value !== I2C_ADDRESS) return new Uint8Array(length)
    if (length >= 5) return Uint8Array.of(0x00, 0x00, 0x02, 0x00, 0xa0)
    if (length === 3) return Uint8Array.of(0x00, 0x00, 0x02)
    return Uint8Array.of(0x96)
  }
}

describe('R82xxTuner', () => {
  it('writes the init array for registers 0x05..0x1f on open', async () => {
    const mock = new MockUsbTransport()
    installR820THandler(mock)
    const tuner = new R82xxTuner('R820T2')
    await tuner.open(new Rtl2832u(mock))

    const writes = i2cWrites(mock, I2C_ADDRESS)
    expect(writes.length).toBeGreaterThan(0)
    const first = writes[0]
    expect(first[0]).toBe(0x05)
    expect(first.subarray(1)).toEqual(R82XX_INIT_ARRAY.subarray(0, 7))
  })

  it('writes PLL registers when tuning', async () => {
    const mock = new MockUsbTransport()
    installR820THandler(mock)
    const tuner = new R82xxTuner('R820T2')
    const rtl = new Rtl2832u(mock)
    await tuner.open(rtl)

    const before = mock.transfers.length
    await tuner.setFrequency(rtl, 509_142_857)

    const newWrites = mock.transfers
      .slice(before)
      .filter(
        (t) => t.type === 'controlOut' && t.index === I2C_WRITE_INDEX && t.value === I2C_ADDRESS,
      )
      .map((t) => t.data ?? new Uint8Array())
    const regs = newWrites.map((data) => data[0])
    expect(regs).toContain(0x10)
    expect(regs).toContain(0x14)
    expect(regs).toContain(0x15)
    expect(regs).toContain(0x16)
  })

  it('derives LNA and mixer indices from the gain table', () => {
    expect(r82xxGainIndex(0)).toEqual({ lna: 0, mixer: 0 })
    expect(r82xxGainIndex(100)).toEqual({ lna: 4, mixer: 3 })
    expect(r82xxGainIndex(1000).lna).toBe(15)
  })
})
