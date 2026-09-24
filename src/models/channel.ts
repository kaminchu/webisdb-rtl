/**
 * Physical channel / frequency models (要件定義書 37).
 *
 * Japanese terrestrial digital TV (ISDB-T) UHF channels are numbered 13..62.
 * The center frequency of channel n is defined as:
 *
 *   fc[MHz] = 473.142857 + (n - 13) * 6
 *
 * The +1/7 MHz offset is the Japanese frequency assignment offset.
 */

export const UHF_CHANNEL_MIN = 13
export const UHF_CHANNEL_MAX = 52

/** Center frequency of UHF channel 13 in Hz. */
export const UHF_CHANNEL_13_HZ = 473_142_857

/** Channel spacing in Hz. */
export const UHF_CHANNEL_SPACING_HZ = 6_000_000

export interface Frequency {
  hz: number
}

export interface PhysicalChannel {
  /** Physical channel number (13..52 normally). */
  channel: number
  /** Center frequency in Hz. */
  frequency: number
}

/** Convert a physical channel number to its center frequency in Hz. */
export function channelToFrequencyHz(channel: number): number {
  return UHF_CHANNEL_13_HZ + (channel - UHF_CHANNEL_MIN) * UHF_CHANNEL_SPACING_HZ
}

/** Round a frequency to the nearest physical channel (best effort). */
export function frequencyToChannel(hz: number): number | null {
  const raw = UHF_CHANNEL_MIN + (hz - UHF_CHANNEL_13_HZ) / UHF_CHANNEL_SPACING_HZ
  const nearest = Math.round(raw)
  if (nearest < UHF_CHANNEL_MIN || nearest > UHF_CHANNEL_MAX) return null
  // Only treat as a physical channel when within 1 MHz of the nominal center.
  if (Math.abs(channelToFrequencyHz(nearest) - hz) > 1_000_000) return null
  return nearest
}

/** Build a PhysicalChannel from a channel number. */
export function physicalChannel(channel: number): PhysicalChannel {
  return { channel, frequency: channelToFrequencyHz(channel) }
}

/** Format a frequency for display. */
export function formatFrequency(hz: number): string {
  return `${(hz / 1_000_000).toFixed(3)} MHz`
}
