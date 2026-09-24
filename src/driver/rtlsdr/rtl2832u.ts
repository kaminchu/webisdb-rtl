/**
 * RTL2832U register/IO layer (要件定義書 11, 12).
 *
 * Implements the vendor control-transfer protocol and the `rtlsdr_init_baseband`
 * sequence. Every demodulator write is followed by the mandatory commit read of
 * page 0x0a / address 0x01.
 */
import type { UsbTransport } from './usbTransport'

export const RTL_BLOCK = {
  DEMOD: 0,
  USB: 1,
  SYS: 2,
  TUN: 3,
  ROM: 4,
  IR: 5,
  IIC: 6,
} as const
export type RtlBlock = (typeof RTL_BLOCK)[keyof typeof RTL_BLOCK]

export const RTL_BULK_ENDPOINT = 0x81
export const RTL_XTAL_HZ = 28800000
export const RTL_MIN_SAMPLE_RATE = 225001
export const RTL_MAX_SAMPLE_RATE = 3200000

/** Default FIR filter uploaded by `rtlsdr_set_fir`. */
export const RTL_FIR_COEFFICIENTS = Uint8Array.from([
  0xca, 0xdc, 0xd7, 0xd8, 0xe0, 0xf2, 0x0e, 0x35, 0x06, 0x50, 0x9c, 0x0d, 0x71, 0x11, 0x14, 0x71,
  0x74, 0x19, 0x41, 0xa5,
])

export function isValidSampleRate(rate: number): boolean {
  return !(rate <= 225000 || rate > RTL_MAX_SAMPLE_RATE || (rate > 300000 && rate <= 900000))
}

function toBigEndian(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (value >>> (8 * (length - 1 - i))) & 0xff
  return out
}

export class Rtl2832u {
  readonly transport: UsbTransport

  constructor(transport: UsbTransport) {
    this.transport = transport
  }

  async open(): Promise<void> {
    await this.transport.open()
    await this.transport.claimInterface(0)
  }

  async close(): Promise<void> {
    await this.transport.releaseInterface(0)
    await this.transport.close()
  }

  // -------------------------------------------------------------------------
  // Raw block / demod transfers
  // -------------------------------------------------------------------------

  readBlock(block: RtlBlock, addr: number, length: number): Promise<Uint8Array> {
    return this.transport.controlIn(0, addr, block << 8, length)
  }

  async writeBlock(block: RtlBlock, addr: number, data: Uint8Array): Promise<void> {
    await this.transport.controlOut(0, addr, (block << 8) | 0x10, data)
  }

  readDemodPage(page: number, addr: number, length: number): Promise<Uint8Array> {
    return this.transport.controlIn(0, (addr << 8) | 0x20, page, length)
  }

  async writeDemodPage(page: number, addr: number, data: Uint8Array): Promise<void> {
    await this.transport.controlOut(0, (addr << 8) | 0x20, 0x10 | page, data)
    await this.readDemodPage(0x0a, 0x01, 1)
  }

  async readDemodReg(page: number, addr: number): Promise<number> {
    const data = await this.readDemodPage(page, addr, 1)
    return data[0]
  }

  async writeDemodReg(page: number, addr: number, value: number, length = 1): Promise<void> {
    await this.writeDemodPage(page, addr, toBigEndian(value, length))
  }

  // -------------------------------------------------------------------------
  // I2C (block 6)
  // -------------------------------------------------------------------------

  async i2cWrite(i2cAddress: number, data: Uint8Array): Promise<void> {
    await this.transport.controlOut(0, i2cAddress, (RTL_BLOCK.IIC << 8) | 0x10, data)
  }

  i2cRead(i2cAddress: number, length: number): Promise<Uint8Array> {
    return this.transport.controlIn(0, i2cAddress, RTL_BLOCK.IIC << 8, length)
  }

  /** I2C repeater: demod page 1 addr 0x01 = 0x18 (on) / 0x10 (off). */
  async setI2cRepeater(on: boolean): Promise<void> {
    await this.writeDemodReg(1, 0x01, on ? 0x18 : 0x10)
  }

  async withI2c<T>(fn: () => Promise<T>): Promise<T> {
    await this.setI2cRepeater(true)
    try {
      return await fn()
    } finally {
      await this.setI2cRepeater(false)
    }
  }

  // -------------------------------------------------------------------------
  // Baseband / streaming setup
  // -------------------------------------------------------------------------

  async resetBuffer(): Promise<void> {
    await this.writeBlock(RTL_BLOCK.USB, 0x2148, toBigEndian(0x1002, 2))
    await this.writeBlock(RTL_BLOCK.USB, 0x2148, toBigEndian(0x0000, 2))
  }

  async initBaseband(): Promise<void> {
    await this.writeBlock(RTL_BLOCK.USB, 0x2000, Uint8Array.of(0x09))
    await this.writeBlock(RTL_BLOCK.USB, 0x2158, toBigEndian(0x0002, 2))
    await this.writeBlock(RTL_BLOCK.USB, 0x2148, toBigEndian(0x1002, 2))
    await this.writeBlock(RTL_BLOCK.SYS, 0x300b, Uint8Array.of(0x22))
    await this.writeBlock(RTL_BLOCK.SYS, 0x3000, Uint8Array.of(0xe8))

    await this.writeDemodReg(1, 0x01, 0x14)
    await this.writeDemodReg(1, 0x01, 0x10)
    await this.writeDemodReg(1, 0x15, 0x00)
    await this.writeDemodReg(1, 0x16, 0x0000, 2)
    await this.writeDemodReg(1, 0x18, 0x0000, 2)
    await this.writeDemodReg(1, 0x1a, 0x0000, 2)

    for (let i = 0; i < RTL_FIR_COEFFICIENTS.length; i++) {
      await this.writeDemodReg(1, 0x1c + i, RTL_FIR_COEFFICIENTS[i])
    }

    await this.writeDemodReg(0, 0x19, 0x05)
    await this.writeDemodReg(1, 0x93, 0xf0)
    await this.writeDemodReg(1, 0x94, 0x0f)
    await this.writeDemodReg(1, 0x11, 0x00)
    await this.writeDemodReg(1, 0x04, 0x00)
    await this.writeDemodReg(0, 0x61, 0x60)
    await this.writeDemodReg(0, 0x06, 0x80)
    await this.writeDemodReg(1, 0xb1, 0x1b)
    await this.writeDemodReg(0, 0x0d, 0x83)
  }

  async setSampleRate(rate: number, ppm = 0): Promise<void> {
    if (!isValidSampleRate(rate)) throw new RangeError(`unsupported sample rate: ${rate}`)
    const rsampRatio = Math.floor((RTL_XTAL_HZ * 2 ** 22) / rate) & 0x0ffffffc
    const real = rsampRatio | ((rsampRatio & 0x08000000) << 1)
    await this.writeDemodReg(1, 0x9f, (real >> 16) & 0xffff, 2)
    await this.writeDemodReg(1, 0xa1, real & 0xffff, 2)

    const offs = Math.round((ppm * -1 * 2 ** 24) / 1e6)
    await this.writeDemodReg(1, 0x3f, offs & 0xff)
    await this.writeDemodReg(1, 0x3e, (offs >> 8) & 0x3f)

    await this.writeDemodReg(1, 0x01, 0x14)
    await this.writeDemodReg(1, 0x01, 0x10)
  }

  async setIfFreq(freq: number): Promise<void> {
    const ifFreq = Math.trunc((freq * 2 ** 22) / RTL_XTAL_HZ) * -1
    await this.writeDemodReg(1, 0x19, (ifFreq >> 16) & 0x3f)
    await this.writeDemodReg(1, 0x1a, (ifFreq >> 8) & 0xff)
    await this.writeDemodReg(1, 0x1b, ifFreq & 0xff)
  }
}
