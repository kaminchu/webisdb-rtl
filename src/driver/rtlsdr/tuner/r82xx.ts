/**
 * Rafael Micro R820T / R828D tuner (real-IF, IF = 3.57 MHz).
 *
 * Port of `tuner_r82xx.c` (VCO algorithm 0). Simplifications, documented per the
 * implementation plan:
 * - no fifth-harmonic retry and no sideband/spectrum-inversion handling; the LO is
 *   always `upconvert + int_freq` (with the Blog V4 HF +28.8 MHz upconvert).
 * - `setMux` uses the standard frequency-range table.
 */
import type { Rtl2832u } from '../rtl2832u'
import type { Tuner } from './tuner'

export type R82xxName = 'R820T2' | 'R828D'

export const R82XX_XTAL_HZ = 28800000
export const R82XX_IF_FREQ_HZ = 3570000
export const R82XX_CHIP_ID = 0x69

/** Init array for registers 0x05..0x1f. */
export const R82XX_INIT_ARRAY = Uint8Array.from([
  0x80, 0x13, 0x70, 0xc0, 0x40, 0xdb, 0x6b, 0xeb, 0x53, 0x75, 0x68, 0x6c, 0xbb, 0x80, 0x31, 0x0f,
  0x00, 0xc0, 0x30, 0x48, 0xec, 0x60, 0x00, 0x24, 0xdd, 0x0e, 0x40,
])

const DEFAULT_IF_VGA = 0x0b

interface R82xxRange {
  freqMhz: number
  openD: number
  rfMuxPloy: number
  tfC: number
}

const R82XX_RANGES: R82xxRange[] = [
  { freqMhz: 0, openD: 0x08, rfMuxPloy: 0x02, tfC: 0xdf },
  { freqMhz: 50, openD: 0x08, rfMuxPloy: 0x02, tfC: 0xbe },
  { freqMhz: 55, openD: 0x08, rfMuxPloy: 0x02, tfC: 0x8b },
  { freqMhz: 60, openD: 0x08, rfMuxPloy: 0x02, tfC: 0x7b },
  { freqMhz: 65, openD: 0x08, rfMuxPloy: 0x02, tfC: 0x69 },
  { freqMhz: 70, openD: 0x08, rfMuxPloy: 0x02, tfC: 0x58 },
  { freqMhz: 75, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x44 },
  { freqMhz: 80, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x44 },
  { freqMhz: 90, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x34 },
  { freqMhz: 100, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x34 },
  { freqMhz: 110, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x24 },
  { freqMhz: 120, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x24 },
  { freqMhz: 140, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x14 },
  { freqMhz: 180, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x13 },
  { freqMhz: 220, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x13 },
  { freqMhz: 250, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x11 },
  { freqMhz: 280, openD: 0x00, rfMuxPloy: 0x02, tfC: 0x00 },
  { freqMhz: 310, openD: 0x00, rfMuxPloy: 0x41, tfC: 0x00 },
  { freqMhz: 450, openD: 0x00, rfMuxPloy: 0x41, tfC: 0x00 },
  { freqMhz: 588, openD: 0x00, rfMuxPloy: 0x40, tfC: 0x00 },
  { freqMhz: 650, openD: 0x00, rfMuxPloy: 0x40, tfC: 0x00 },
]

const LNA_GAIN_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13]
const MIXER_GAIN_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8]

export function r82xxGainIndex(gainTenthDb: number): { lna: number; mixer: number } {
  let total = 0
  let lna = 0
  let mixer = 0
  for (let i = 0; i < 15; i++) {
    if (total >= gainTenthDb) break
    total += LNA_GAIN_STEPS[++lna]
    if (total >= gainTenthDb) break
    total += MIXER_GAIN_STEPS[++mixer]
  }
  return { lna, mixer }
}

export function r82xxBitReverse(byte: number): number {
  const lut = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf]
  return (lut[byte & 0xf] << 4) | lut[byte >> 4]
}

export class R82xxTuner implements Tuner {
  readonly name: R82xxName
  readonly i2cAddress: number
  readonly ifFrequencyHz = R82XX_IF_FREQ_HZ
  readonly zeroIf = false

  private readonly vcoPowerRef: number
  private readonly cache = new Uint8Array(32)
  private filCalCode = 0

  constructor(name: R82xxName) {
    this.name = name
    this.i2cAddress = name === 'R828D' ? 0x74 : 0x34
    this.vcoPowerRef = name === 'R828D' ? 1 : 2
  }

  async open(rtl: Rtl2832u): Promise<void> {
    await rtl.withI2c(async () => {
      const chipId = await this.read(rtl, 1)
      if (chipId[0] !== R82XX_CHIP_ID) {
        throw new Error(`${this.name} not found (chip id 0x${chipId[0].toString(16)})`)
      }
      await this.writeArray(rtl, 0x05, R82XX_INIT_ARRAY)
      await this.setTvStandard(rtl)
      await this.sysfreqSel(rtl)
    })
  }

  async setFrequency(rtl: Rtl2832u, hz: number): Promise<void> {
    await rtl.withI2c(async () => {
      const upconvert = this.name === 'R828D' && hz < 28_800_000 ? hz + 28_800_000 : hz
      const lo = upconvert + this.ifFrequencyHz
      await this.setMux(rtl, lo)
      await this.setPll(rtl, lo)
    })
  }

  async setGain(rtl: Rtl2832u, gainDb: number | 'auto'): Promise<void> {
    await rtl.withI2c(async () => {
      if (gainDb === 'auto') {
        await this.writeRegMask(rtl, 0x05, 0x00, 0x10)
        await this.writeRegMask(rtl, 0x07, 0x10, 0x10)
      } else {
        const { lna, mixer } = r82xxGainIndex(gainDb)
        await this.writeRegMask(rtl, 0x05, 0x10, 0x10)
        await this.writeRegMask(rtl, 0x07, 0x00, 0x10)
        await this.writeRegMask(rtl, 0x05, lna, 0x0f)
        await this.writeRegMask(rtl, 0x07, mixer, 0x0f)
      }
      await this.writeRegMask(rtl, 0x0c, DEFAULT_IF_VGA, 0x1f)
    })
  }

  private async read(rtl: Rtl2832u, length: number): Promise<Uint8Array> {
    const raw = await rtl.i2cRead(this.i2cAddress, length)
    return raw.map(r82xxBitReverse)
  }

  private async writeArray(rtl: Rtl2832u, reg: number, data: Uint8Array): Promise<void> {
    let offset = 0
    while (offset < data.length) {
      const size = Math.min(7, data.length - offset)
      const payload = new Uint8Array(size + 1)
      payload[0] = reg + offset
      payload.set(data.subarray(offset, offset + size), 1)
      await rtl.i2cWrite(this.i2cAddress, payload)
      for (let k = 0; k < size; k++) this.cache[reg + offset + k] = data[offset + k]
      offset += size
    }
  }

  private writeReg(rtl: Rtl2832u, reg: number, value: number): Promise<void> {
    return this.writeArray(rtl, reg, Uint8Array.of(value))
  }

  private async writeRegMask(
    rtl: Rtl2832u,
    reg: number,
    value: number,
    mask: number,
  ): Promise<void> {
    const current = this.cache[reg]
    await this.writeReg(rtl, reg, (current & ~mask) | (value & mask))
  }

  private async setMux(rtl: Rtl2832u, freq: number): Promise<void> {
    const mhz = Math.floor(freq / 1000000)
    let i = 0
    for (; i < R82XX_RANGES.length - 1; i++) {
      if (mhz < R82XX_RANGES[i + 1].freqMhz) break
    }
    const range = R82XX_RANGES[i]
    await this.writeRegMask(rtl, 0x17, range.openD, 0x08)
    await this.writeRegMask(rtl, 0x1a, range.rfMuxPloy, 0xc3)
    await this.writeReg(rtl, 0x1b, range.tfC)
    await this.writeRegMask(rtl, 0x10, 0x00, 0x0b)
  }

  private async setTvStandard(rtl: Rtl2832u): Promise<void> {
    for (let i = 0; i < 2; i++) {
      await this.writeRegMask(rtl, 0x0f, 0x04, 0x04)
      await this.setPll(rtl, 56000000)
      await this.writeRegMask(rtl, 0x0b, 0x10, 0x10)
      await this.writeRegMask(rtl, 0x0b, 0x00, 0x10)
      await this.writeRegMask(rtl, 0x0f, 0x00, 0x04)
      const data = await this.read(rtl, 5)
      this.filCalCode = data[4] & 0x0f
      if (this.filCalCode && this.filCalCode !== 0x0f) break
    }
    if (this.filCalCode === 0x0f) this.filCalCode = 0
    await this.writeRegMask(rtl, 0x0a, 0x10 | this.filCalCode, 0x1f)
  }

  private async sysfreqSel(rtl: Rtl2832u): Promise<void> {
    await this.writeRegMask(rtl, 0x05, 0x00, 0x60)
    await this.writeRegMask(rtl, 0x06, 0x00, 0x08)
    await this.writeRegMask(rtl, 0x1d, 0x00, 0x38)
    await this.writeRegMask(rtl, 0x06, 0x00, 0x40)
    await this.writeRegMask(rtl, 0x1a, 0x30, 0x30)
    await this.writeRegMask(rtl, 0x1d, 0x18, 0x38)
    await this.writeRegMask(rtl, 0x1a, 0x20, 0x30)
  }

  private async setPll(rtl: Rtl2832u, freq: number): Promise<void> {
    const vcoMinKhz = 1770000
    const vcoMaxKhz = 3540000
    const freqKhz = Math.floor((freq + 500) / 1000)

    let mixDiv = 2
    let divNum = 0
    while (mixDiv <= 64) {
      if (freqKhz * mixDiv >= vcoMinKhz && freqKhz * mixDiv < vcoMaxKhz) {
        let divBuf = mixDiv
        while (divBuf > 2) {
          divBuf >>= 1
          divNum++
        }
        break
      }
      mixDiv <<= 1
    }

    const status = await this.read(rtl, 5)
    const vcoFineTune = (status[4] & 0x30) >> 4
    if (vcoFineTune > this.vcoPowerRef) divNum -= 1
    else if (vcoFineTune < this.vcoPowerRef) divNum += 1

    await this.writeRegMask(rtl, 0x10, divNum << 5, 0xe0)

    const vcoFreq = freq * mixDiv
    const vcoDiv = Math.floor((R82XX_XTAL_HZ + 65536 * vcoFreq) / (2 * R82XX_XTAL_HZ))
    const nint = Math.floor(vcoDiv / 65536)
    const sdm = vcoDiv % 65536
    if (nint > 128 / this.vcoPowerRef - 1) throw new Error(`R82XX has no valid PLL for ${freq} Hz`)

    const ni = Math.floor((nint - 13) / 4)
    const si = nint - 4 * ni - 13
    await this.writeReg(rtl, 0x14, ni + (si << 6))
    await this.writeRegMask(rtl, 0x12, sdm === 0 ? 0x08 : 0x00, 0x18)
    await this.writeReg(rtl, 0x16, sdm >> 8)
    await this.writeReg(rtl, 0x15, sdm & 0xff)

    const lock = await this.read(rtl, 3)
    if (!(lock[2] & 0x40)) throw new Error(`R82XX PLL did not lock at ${freq} Hz`)

    await this.writeRegMask(rtl, 0x1a, 0x08, 0x08)
  }
}
