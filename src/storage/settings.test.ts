import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultSettings,
  loadSettings,
  resetSettings,
  saveSettings,
  SETTINGS_STORAGE_KEY,
} from './settings'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings()).toEqual(defaultSettings())
  })

  it('persists and reloads a patch', () => {
    saveSettings({ lastRegionId: 'niigata', lastChannel: 19, gainDb: 12.5 })
    expect(loadSettings()).toEqual({
      ...defaultSettings(),
      lastRegionId: 'niigata',
      lastChannel: 19,
      gainDb: 12.5,
    })
  })

  it('merges nested ui and debug without dropping sibling fields', () => {
    saveSettings({ debug: { spectrum: true, showPsi: false, showPidList: false } })
    saveSettings({ ui: { theme: 'dark' } })
    const settings = saveSettings({ debug: { showPsi: true } })
    expect(settings.debug).toEqual({
      spectrum: true,
      showPsi: true,
      showPidList: false,
      showOverlay: false,
    })
    expect(settings.ui).toEqual({ theme: 'dark', subtitles: false, audioChannel: 'stereo' })
  })

  it('persists subtitle, audio channel, and debug overlay preferences', () => {
    saveSettings({ ui: { subtitles: true, audioChannel: 'sub' }, debug: { showOverlay: true } })
    const settings = loadSettings()
    expect(settings.ui.subtitles).toBe(true)
    expect(settings.ui.audioChannel).toBe('sub')
    expect(settings.debug.showOverlay).toBe(true)
  })

  it('rejects an invalid audio channel', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ui: { audioChannel: 'surround' } }))
    expect(loadSettings().ui.audioChannel).toBe('stereo')
  })

  it('tolerates malformed JSON', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, '{not json')
    expect(loadSettings()).toEqual(defaultSettings())
  })

  it('ignores non-object and wrongly typed values', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify('nope'))
    expect(loadSettings()).toEqual(defaultSettings())

    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ lastChannel: 'x', gainDb: Number.NaN, ui: { theme: 'blue' } }),
    )
    expect(loadSettings()).toEqual(defaultSettings())
  })

  it('resets stored values', () => {
    saveSettings({ lastChannel: 13 })
    expect(resetSettings()).toEqual(defaultSettings())
    expect(loadSettings()).toEqual(defaultSettings())
  })

  it('works when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadSettings()).toEqual(defaultSettings())
    expect(saveSettings({ lastChannel: 13 })).toEqual({
      ...defaultSettings(),
      lastChannel: 13,
    })
    expect(resetSettings()).toEqual(defaultSettings())
  })
})
