import type { Rtl2832u } from '../rtl2832u'

export type TunerName = 'R820T2' | 'R828D' | 'FC0013' | 'unknown'

export interface Tuner {
  readonly name: TunerName
  /** 8-bit I2C address (not shifted). */
  readonly i2cAddress: number
  /** Intermediate frequency in Hz; 0 for zero-IF tuners. */
  readonly ifFrequencyHz: number
  readonly zeroIf: boolean
  open(rtl: Rtl2832u): Promise<void>
  setFrequency(rtl: Rtl2832u, hz: number): Promise<void>
  setGain(rtl: Rtl2832u, gainDb: number | 'auto'): Promise<void>
}
