import { describe, expect, it } from 'vitest'
import { Rtl2832u } from '../rtl2832u'
import { MockUsbTransport } from '../usbTransport'
import { Fc0013Tuner, fc0013InitRegisters, fc0013LnaGainCode, fc0013PllRegisters } from './fc0013'

describe('Fc0013Tuner gain', () => {
  it.each([
    [19.7, 0x50],
    [7.1, 0x48],
    [-7.3, 0x43],
  ])('programs %s dB while preserving the UHF band filter', async (gainDb, register) => {
    const transport = new MockUsbTransport()
    transport.controlInHandler = () => Uint8Array.of(0x40)
    await new Fc0013Tuner().setGain(new Rtl2832u(transport), gainDb)
    const gainWrite = transport.transfers.find(
      (t) =>
        t.type === 'controlOut' && t.value === 0xc6 && t.data?.[0] === 0x14 && t.data.length === 2,
    )
    expect(gainWrite?.data).toEqual(Uint8Array.of(0x14, register))
  })
})

describe('fc0013InitRegisters', () => {
  it('applies the 0x07/0x0c overrides to the init table', () => {
    const regs = fc0013InitRegisters()
    expect(regs[0x01]).toBe(0x09)
    expect(regs[0x07]).toBe(0x0a | 0x20)
    expect(regs[0x0c]).toBe(0xfc | 0x02)
    expect(regs[0x15]).toBe(0x01)
    expect(regs[0x00]).toBe(0x00)
  })
})

describe('fc0013PllRegisters', () => {
  it('computes a valid PLL tuple for 509.142857 MHz', () => {
    const pll = fc0013PllRegisters(509_142_857)
    expect(pll).not.toBeNull()
    expect(pll).toEqual({
      multi: 6,
      vcoSelect: 0,
      reg1: 0x04,
      reg2: 0x1a,
      reg3: 0x12,
      reg4: 0x48,
      reg5: 0x0f,
      reg6: 0xa0,
    })
    expect(pll!.reg1).toBeLessThanOrEqual(15)
    expect(pll!.reg2).toBeGreaterThanOrEqual(0x0b)
  })

  it('is deterministic', () => {
    expect(fc0013PllRegisters(509_142_857)).toEqual(fc0013PllRegisters(509_142_857))
  })
})

describe('fc0013LnaGainCode', () => {
  it('maps a requested gain to the nearest table code', () => {
    expect(fc0013LnaGainCode(-99)).toBe(0x02)
    expect(fc0013LnaGainCode(0)).toBe(0x0f)
    expect(fc0013LnaGainCode(197)).toBe(0x10)
    expect(fc0013LnaGainCode(999)).toBe(0x10)
  })
})
