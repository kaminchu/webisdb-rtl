/**
 * localStorage-backed user settings (要件定義書 22).
 *
 * Small preferences (last region/channel, gain, UI and debug toggles) live here while
 * bulky broadcast metadata goes to IndexedDB. All access is guarded so the module is
 * safe under SSR / private-mode where `localStorage` may be missing or throw.
 */

import { AudioChannelMode } from '../models/media'

export interface AppSettings {
  lastRegionId: string | null
  lastChannel: number | null
  lastFrequency: number | null
  gainDb: number | null
  sampleRate: number | null
  ui: { theme?: 'dark' | 'light'; subtitles: boolean; audioChannel: AudioChannelMode }
  debug: { spectrum: boolean; showPsi: boolean; showPidList: boolean; showOverlay: boolean }
}

/** Deep-partial patch accepted by `saveSettings`; nested `ui`/`debug` merge field-wise. */
export type SettingsPatch = Partial<Omit<AppSettings, 'ui' | 'debug'>> & {
  ui?: Partial<AppSettings['ui']>
  debug?: Partial<AppSettings['debug']>
}

export const SETTINGS_STORAGE_KEY = 'webisdb-rtl:settings'

export function defaultSettings(): AppSettings {
  return {
    lastRegionId: null,
    lastChannel: null,
    lastFrequency: null,
    gainDb: null,
    sampleRate: null,
    ui: { subtitles: false, audioChannel: AudioChannelMode.Stereo },
    debug: { spectrum: false, showPsi: false, showPidList: false, showOverlay: false },
  }
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringOrNull(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  return typeof value === 'string' ? value : fallback
}

function asNumberOrNull(value: unknown, fallback: number | null): number | null {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asTheme(value: unknown): 'dark' | 'light' | undefined {
  return value === 'dark' || value === 'light' ? value : undefined
}

function asAudioChannel(value: unknown): AudioChannelMode | undefined {
  return value === AudioChannelMode.Stereo ||
    value === AudioChannelMode.Main ||
    value === AudioChannelMode.Sub
    ? value
    : undefined
}

function readRaw(): Partial<AppSettings> {
  const storage = getStorage()
  if (!storage) return {}
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as Partial<AppSettings>) : {}
  } catch {
    return {}
  }
}

function mergeSettings(base: AppSettings, patch: SettingsPatch): AppSettings {
  const ui = isRecord(patch.ui) ? patch.ui : {}
  const debug = isRecord(patch.debug) ? patch.debug : {}
  const theme = asTheme(ui.theme)
  const audioChannel = asAudioChannel(ui.audioChannel)
  return {
    lastRegionId: asStringOrNull(patch.lastRegionId, base.lastRegionId),
    lastChannel: asNumberOrNull(patch.lastChannel, base.lastChannel),
    lastFrequency: asNumberOrNull(patch.lastFrequency, base.lastFrequency),
    gainDb: asNumberOrNull(patch.gainDb, base.gainDb),
    sampleRate: asNumberOrNull(patch.sampleRate, base.sampleRate),
    ui: {
      ...base.ui,
      ...(theme === undefined ? {} : { theme }),
      subtitles: asBoolean(ui.subtitles, base.ui.subtitles),
      audioChannel: audioChannel ?? base.ui.audioChannel,
    },
    debug: {
      spectrum: asBoolean(debug.spectrum, base.debug.spectrum),
      showPsi: asBoolean(debug.showPsi, base.debug.showPsi),
      showPidList: asBoolean(debug.showPidList, base.debug.showPidList),
      showOverlay: asBoolean(debug.showOverlay, base.debug.showOverlay),
    },
  }
}

export function loadSettings(): AppSettings {
  return mergeSettings(defaultSettings(), readRaw())
}

export function saveSettings(patch: SettingsPatch): AppSettings {
  const next = mergeSettings(loadSettings(), patch)
  const storage = getStorage()
  if (storage) {
    try {
      storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // ignore quota / serialization failures
    }
  }
  return next
}

export function resetSettings(): AppSettings {
  const storage = getStorage()
  if (storage) {
    try {
      storage.removeItem(SETTINGS_STORAGE_KEY)
    } catch {
      // ignore
    }
  }
  return defaultSettings()
}
