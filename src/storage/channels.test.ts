import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHANNELS_STORAGE_KEY, loadConfiguredChannels, saveConfiguredChannels } from './channels'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('configured channels', () => {
  it('returns an empty list when nothing is stored', () => {
    expect(loadConfiguredChannels()).toEqual([])
  })

  it('saves, sorts, and deduplicates by physical channel', () => {
    const saved = saveConfiguredChannels([
      { physicalChannel: 17, name: 'BSN' },
      { physicalChannel: 13, name: 'NHK Eテレ' },
      { physicalChannel: 13, name: 'duplicate' },
    ])
    expect(saved.map((channel) => channel.physicalChannel)).toEqual([13, 17])
    expect(loadConfiguredChannels()).toEqual(saved)
  })

  it('drops malformed entries', () => {
    localStorage.setItem(
      CHANNELS_STORAGE_KEY,
      JSON.stringify([{ physicalChannel: 'x' }, { name: 'no channel' }, { physicalChannel: 19 }]),
    )
    expect(loadConfiguredChannels()).toEqual([{ physicalChannel: 19 }])
  })

  it('tolerates invalid JSON and missing storage', () => {
    localStorage.setItem(CHANNELS_STORAGE_KEY, '{not json')
    expect(loadConfiguredChannels()).toEqual([])

    vi.stubGlobal('localStorage', undefined)
    expect(loadConfiguredChannels()).toEqual([])
    expect(saveConfiguredChannels([{ physicalChannel: 13 }])).toEqual([{ physicalChannel: 13 }])
  })
})
