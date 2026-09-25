import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_BUFFER_SECONDS,
  MAX_BUFFER_SECONDS,
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
    saveSettings({ debug: { showOverlay: true } })
    saveSettings({ ui: { theme: 'dark' } })
    const settings = saveSettings({ ui: { subtitles: true } })
    expect(settings.debug).toEqual({ showOverlay: true })
    expect(settings.ui).toEqual({ theme: 'dark', subtitles: true, audioChannel: 'stereo' })
  })

  it('persists subtitle, audio channel, and debug overlay preferences', () => {
    saveSettings({ ui: { subtitles: true, audioChannel: 'sub' }, debug: { showOverlay: true } })
    const settings = loadSettings()
    expect(settings.ui.subtitles).toBe(true)
    expect(settings.ui.audioChannel).toBe('sub')
    expect(settings.debug.showOverlay).toBe(true)
  })

  it('defaults the playback buffer to three seconds', () => {
    expect(defaultSettings().bufferSeconds).toBe(DEFAULT_BUFFER_SECONDS)
    expect(DEFAULT_BUFFER_SECONDS).toBe(3)
  })

  it('clamps the playback buffer and rejects invalid values', () => {
    saveSettings({ bufferSeconds: 5 })
    expect(loadSettings().bufferSeconds).toBe(5)
    saveSettings({ bufferSeconds: 99 })
    expect(loadSettings().bufferSeconds).toBe(MAX_BUFFER_SECONDS)

    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ bufferSeconds: -1 }))
    expect(loadSettings().bufferSeconds).toBe(DEFAULT_BUFFER_SECONDS)
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ bufferSeconds: 'x' }))
    expect(loadSettings().bufferSeconds).toBe(DEFAULT_BUFFER_SECONDS)
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
