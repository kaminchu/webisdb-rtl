/**
 * Fitipower FC0013 tuner (zero-IF, used by the local dev dongle).
 *
 * Port of `tuner_fc0013.c` from librtlsdr. The FC0013 I2C protocol writes the
 * target register before each read.
 */
import type { Rtl2832u } from '../rtl2832u'
import type { Tuner } from './tuner'

export const FC0013_I2C_ADDRESS = 0xc6
export const FC0013_CHIP_ID = 0xa3
export const FC0013_XTAL_DIV2 = 14400000

const FC0013_INIT_TABLE = Uint8Array.from([
  0x09, 0x16, 0x00, 0x00, 0x17, 0x02, 0x0a, 0xff, 0x6e, 0xb8, 0x82, 0xfc, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x50, 0x01,
])

/** Registers 1..21 with the fixed `0x07 |= 0x20` and `0x0c |= 0x02` applied. */
export function fc0013InitRegisters(): Uint8Array {
  const regs = new Uint8Array(22)
  regs.set(FC0013_INIT_TABLE, 1)
  regs[0x07] |= 0x20
  regs[0x0c] |= 0x02
  return regs
}

export interface Fc0013Pll {
  multi: number
  vcoSelect: number
  reg1: number
  reg2: number
  reg3: number
  reg4: number
  reg5: number
  reg6: number
}

const FC0013_BANDS: ReadonlyArray<readonly [number, number, number, number]> = [
  [37084000, 96, 0x82, 0x00],
  [55625000, 64, 0x02, 0x02],
  [74167000, 48, 0x42, 0x00],
  [111250000, 32, 0x82, 0x02],
  [148334000, 24, 0x22, 0x00],
  [222500000, 16, 0x42, 0x02],
  [296667000, 12, 0x12, 0x00],
  [445000000, 8, 0x22, 0x02],
  [593334000, 6, 0x0a, 0x00],
  [950000000, 4, 0x12, 0x02],
]

/** Pure PLL computation; returns null when no valid divider combination exists. */
export function fc0013PllRegisters(freq: number): Fc0013Pll | null {
  let multi = 2
  let reg5 = 0x0a
  let reg6 = 0x02
  for (const [limit, bandMulti, bandReg5, bandReg6] of FC0013_BANDS) {
    if (freq < limit) {
      multi = bandMulti
      reg5 = bandReg5
      reg6 = bandReg6
      break
    }
  }

  const fVco = freq * multi
  let vcoSelect = 0
  if (fVco >= 3060000000) {
    reg6 |= 0x08
    vcoSelect = 1
  }

  let xdiv = Math.trunc(fVco / FC0013_XTAL_DIV2)
  if (fVco - xdiv * FC0013_XTAL_DIV2 >= FC0013_XTAL_DIV2 / 2) xdiv++
  let pm = Math.trunc(xdiv / 8)
  let am = xdiv - 8 * pm
  if (am < 2) {
    am += 8
    pm--
  }

  let reg1: number
  let reg2: number
  if (pm > 31) {
    reg1 = am + 8 * (pm - 31)
    reg2 = 31
  } else {
    reg1 = am
    reg2 = pm
  }
  if (reg1 > 15 || reg2 < 0x0b) return null

  reg6 |= 0x20
  let xin = Math.trunc((fVco - Math.trunc(fVco / FC0013_XTAL_DIV2) * FC0013_XTAL_DIV2) / 1000)
  xin = Math.trunc((xin << 15) / (FC0013_XTAL_DIV2 / 1000))
  if (xin >= 16384) xin += 32768
  const reg3 = xin >> 8
  const reg4 = xin & 0xff

  reg6 &= 0x3f
  reg6 |= 0x80
  reg5 |= 0x07

  return { multi, vcoSelect, reg1, reg2, reg3, reg4, reg5, reg6 }
}

const FC0013_GAIN_TABLE: ReadonlyArray<readonly [number, number]> = [
  [-99, 0x02],
  [-73, 0x03],
  [-65, 0x05],
  [-63, 0x04],
  [-63, 0x00],
  [-60, 0x07],
  [-58, 0x01],
  [-54, 0x06],
  [58, 0x0f],
  [61, 0x0e],
  [63, 0x0d],
  [65, 0x0c],
  [67, 0x0b],
  [68, 0x0a],
  [70, 0x09],
  [71, 0x08],
  [179, 0x17],
  [181, 0x16],
  [182, 0x15],
  [184, 0x14],
  [186, 0x13],
  [188, 0x12],
  [191, 0x11],
  [197, 0x10],
]

/** LNA gain code for reg 0x14[4:0] in tenths of a dB. */
export function fc0013LnaGainCode(gainTenthDb: number): number {
  for (let i = 0; i < FC0013_GAIN_TABLE.length; i++) {
    const [value, code] = FC0013_GAIN_TABLE[i]
    if (value >= gainTenthDb || i + 1 === FC0013_GAIN_TABLE.length) return code
  }
  return 0x00
}

export class Fc0013Tuner implements Tuner {
  readonly name = 'FC0013' as const
  readonly i2cAddress = FC0013_I2C_ADDRESS
  readonly ifFrequencyHz = 0
  readonly zeroIf = true

  private readReg(rtl: Rtl2832u, reg: number): Promise<number> {
    return rtl
      .i2cWrite(this.i2cAddress, Uint8Array.of(reg))
      .then(() => rtl.i2cRead(this.i2cAddress, 1))
      .then((data) => data[0])
  }

  private async writeReg(rtl: Rtl2832u, reg: number, value: number): Promise<void> {
    await rtl.i2cWrite(this.i2cAddress, Uint8Array.of(reg, value))
  }

  async open(rtl: Rtl2832u): Promise<void> {
    await rtl.withI2c(async () => {
      const chipId = await this.readReg(rtl, 0x00)
      if (chipId !== FC0013_CHIP_ID) {
        throw new Error(`FC0013 not found (chip id 0x${chipId.toString(16)})`)
      }
      const regs = fc0013InitRegisters()
      for (let reg = 1; reg <= 21; reg++) await this.writeReg(rtl, reg, regs[reg])
    })
  }

  async setFrequency(rtl: Rtl2832u, hz: number): Promise<void> {
    const pll = fc0013PllRegisters(hz)
    if (!pll) throw new Error(`FC0013 has no valid PLL setting for ${hz} Hz`)

    await rtl.withI2c(async () => {
      await this.setVhfTrack(rtl, hz)
      await this.setBandFilter(rtl, hz)

      const pllRegs = [pll.reg1, pll.reg2, pll.reg3, pll.reg4, pll.reg5, pll.reg6]
      for (let reg = 1; reg <= 6; reg++) await this.writeReg(rtl, reg, pllRegs[reg - 1])

      const reg11 = await this.readReg(rtl, 0x11)
      await this.writeReg(rtl, 0x11, pll.multi === 64 ? reg11 | 0x04 : reg11 & 0xfb)

      await this.writeReg(rtl, 0x0e, 0x80)
      await this.writeReg(rtl, 0x0e, 0x00)
      await this.writeReg(rtl, 0x0e, 0x00)
      const cal = (await this.readReg(rtl, 0x0e)) & 0x3f
      const outOfRange = pll.vcoSelect ? cal > 0x3c : cal < 0x02
      if (outOfRange) {
        const reg6 = pll.vcoSelect ? pll.reg6 & ~0x08 : pll.reg6 | 0x08
        await this.writeReg(rtl, 0x06, reg6)
        await this.writeReg(rtl, 0x0e, 0x80)
        await this.writeReg(rtl, 0x0e, 0x00)
      }
    })
  }

  async setGain(rtl: Rtl2832u, gainDb: number | 'auto'): Promise<void> {
    await rtl.withI2c(async () => {
      const manual = gainDb !== 'auto'
      let reg0d = await this.readReg(rtl, 0x0d)
      reg0d = manual ? reg0d | 0x08 : reg0d & ~0x08
      await this.writeReg(rtl, 0x0d, reg0d)
      await this.writeReg(rtl, 0x13, 0x0a)

      if (manual) {
        const reg14 = (await this.readReg(rtl, 0x14)) & 0xe0
        await this.writeReg(rtl, 0x14, reg14 | fc0013LnaGainCode(gainDb))
      }
    })
  }

  private async setVhfTrack(rtl: Rtl2832u, hz: number): Promise<void> {
    let value = (await this.readReg(rtl, 0x1d)) & 0xe3
    if (hz <= 177500000) value |= 0x1c
    else if (hz <= 184500000) value |= 0x18
    else if (hz <= 191500000) value |= 0x14
    else if (hz <= 198500000) value |= 0x10
    else if (hz <= 205500000) value |= 0x0c
    else if (hz <= 219500000) value |= 0x08
    else if (hz < 300000000) value |= 0x04
    else value |= 0x1c
    await this.writeReg(rtl, 0x1d, value)
  }

  private async setBandFilter(rtl: Rtl2832u, hz: number): Promise<void> {
    let reg07 = await this.readReg(rtl, 0x07)
    let reg14 = await this.readReg(rtl, 0x14)
    if (hz < 300000000) {
      reg07 |= 0x10
      reg14 &= 0x1f
    } else if (hz <= 862000000) {
      reg07 &= 0xef
      reg14 = (reg14 & 0x1f) | 0x40
    } else {
      reg07 &= 0xef
      reg14 = (reg14 & 0x1f) | 0x20
    }
    await this.writeReg(rtl, 0x07, reg07)
    await this.writeReg(rtl, 0x14, reg14)
  }
}
