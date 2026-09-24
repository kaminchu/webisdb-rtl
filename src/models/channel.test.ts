import { describe, expect, it } from 'vitest'
import {
  channelToFrequencyHz,
  frequencyToChannel,
  physicalChannel,
  UHF_CHANNEL_13_HZ,
} from './channel'

describe('channelToFrequencyHz', () => {
  it('maps channel 13 to the known 473.142857 MHz center', () => {
    expect(channelToFrequencyHz(13)).toBe(UHF_CHANNEL_13_HZ)
  })

  it('spaces channels by 6 MHz', () => {
    expect(channelToFrequencyHz(14) - channelToFrequencyHz(13)).toBe(6_000_000)
    expect(channelToFrequencyHz(52) - channelToFrequencyHz(13)).toBe(39 * 6_000_000)
  })

  it('returns a physical channel with a derived frequency', () => {
    expect(physicalChannel(19)).toEqual({ channel: 19, frequency: channelToFrequencyHz(19) })
  })
})

describe('frequencyToChannel', () => {
  it('round-trips exact channel frequencies', () => {
    for (let ch = 13; ch <= 52; ch++) {
      expect(frequencyToChannel(channelToFrequencyHz(ch))).toBe(ch)
    }
  })

  it('rejects frequencies far from the grid', () => {
    expect(frequencyToChannel(channelToFrequencyHz(19) + 4_000_000)).toBeNull()
    expect(frequencyToChannel(100_000_000)).toBeNull()
  })
})
