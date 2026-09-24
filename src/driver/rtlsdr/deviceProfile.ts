/**
 * Device identification and per-profile initialisation (要件定義書 11, 12).
 *
 * The tuner is probed over I2C; the RTL-SDR Blog V3/V4 are distinguished by their
 * R820T2 / R828D tuners, while the local generic dongle uses an FC0013.
 */
import { Rtl2832u } from './rtl2832u'
import type { UsbTransport } from './usbTransport'
import type { Tuner, TunerName } from './tuner/tuner'
import { Fc0013Tuner } from './tuner/fc0013'
import { R82xxTuner, r82xxBitReverse } from './tuner/r82xx'

export type DeviceModel = 'RTL-SDR Blog V3' | 'RTL-SDR Blog V4' | 'Generic RTL2832U'

export interface DeviceProfile {
  vendorId: number
  productId: number
  model: DeviceModel
  tuner: TunerName
  i2cAddress: number
  ifFrequencyHz: number
  zeroIf: boolean
}

export const RTL_SDR_VENDOR_IDS = [0x0bda] as const
export const RTL_SDR_PRODUCT_IDS = [0x2832, 0x2838] as const

async function probe(
  rtl: Rtl2832u,
  address: number,
  expected: number,
  writeRegister: boolean,
  bitReverse = false,
): Promise<boolean> {
  if (writeRegister) await rtl.i2cWrite(address, Uint8Array.of(0x00))
  const data = await rtl.i2cRead(address, 1)
  const value = bitReverse ? r82xxBitReverse(data[0]) : data[0]
  return value === expected
}

export async function identifyDevice(transport: UsbTransport): Promise<DeviceProfile> {
  if (!transport.isOpen) await transport.open()
  await transport.claimInterface(0)

  const rtl = new Rtl2832u(transport)
  await rtl.initBaseband()
  await rtl.setI2cRepeater(true)

  let tuner: TunerName = 'unknown'
  let i2cAddress = 0
  let zeroIf = false
  try {
    if (await probe(rtl, 0xc6, 0xa3, true)) {
      tuner = 'FC0013'
      i2cAddress = 0xc6
      zeroIf = true
    } else if (await probe(rtl, 0x74, 0x69, false, true)) {
      tuner = 'R828D'
      i2cAddress = 0x74
    } else if (await probe(rtl, 0x34, 0x69, false, true)) {
      tuner = 'R820T2'
      i2cAddress = 0x34
    }
  } finally {
    await rtl.setI2cRepeater(false)
  }

  const model: DeviceModel =
    tuner === 'R828D'
      ? 'RTL-SDR Blog V4'
      : tuner === 'R820T2'
        ? 'RTL-SDR Blog V3'
        : 'Generic RTL2832U'

  return {
    vendorId: transport.vendorId,
    productId: transport.productId,
    model,
    tuner,
    i2cAddress,
    ifFrequencyHz: zeroIf ? 0 : 3570000,
    zeroIf,
  }
}

export function createTuner(name: TunerName): Tuner {
  switch (name) {
    case 'FC0013':
      return new Fc0013Tuner()
    case 'R820T2':
      return new R82xxTuner('R820T2')
    case 'R828D':
      return new R82xxTuner('R828D')
    default:
      throw new Error(`unsupported tuner: ${name}`)
  }
}

/** Real-IF tuners need the demodulator configured for the 3.57 MHz IF. */
export async function applyProfileInit(rtl: Rtl2832u, profile: DeviceProfile): Promise<void> {
  if (profile.zeroIf) return
  await rtl.writeDemodReg(1, 0xb1, 0x1a)
  await rtl.writeDemodReg(0, 0x08, 0x4d)
  await rtl.setIfFreq(profile.ifFrequencyHz)
  await rtl.writeDemodReg(1, 0x15, 0x01)
}
