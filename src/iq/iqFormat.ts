/**
 * `.iq` + `.iq.json` capture metadata (要件定義書 33, 34).
 */

import type { IqSampleFormat } from './IQSource'

export interface IqMetadata {
  /** File format version. */
  version: 1
  /** Sample format of the raw file. */
  format: IqSampleFormat
  /** Complex sample rate in Hz. */
  sampleRate: number
  /** Tuner center frequency in Hz. */
  centerFrequency: number
  /** Tuner gain in dB, or null for AGC. */
  gainDb: number | null
  /** PPM correction applied. */
  ppm: number
  /** Capture start time (ISO 8601). */
  timestamp: string
  /** Device model string. */
  device: string
  /** Tuner information. */
  tuner: string
  /** Physical channel, if the capture was tied to one. */
  physicalChannel?: number
  /** Optional free-form note. */
  note?: string
}

export const IQ_METADATA_VERSION = 1

export function isIqMetadata(value: unknown): value is IqMetadata {
  if (typeof value !== 'object' || value === null) return false
  const m = value as Record<string, unknown>
  return (
    m.version === IQ_METADATA_VERSION &&
    (m.format === 'u8' || m.format === 'i8' || m.format === 'f32') &&
    typeof m.sampleRate === 'number' &&
    typeof m.centerFrequency === 'number'
  )
}
