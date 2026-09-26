/**
 * localStorage-backed user settings (要件定義書 22).
 *
 * Small preferences (last region/channel, gain, UI and debug toggles) live here while
 * bulky broadcast metadata goes to IndexedDB. All access is guarded so the module is
 * safe under SSR / private-mode where `localStorage` may be missing or throw.
 */

import { AudioChannelMode } from '../models/media'
import { RtlFrontendMode } from '../driver/rtlsdr/rtl2832u'

export interface AppSettings {
  lastRegionId: string | null
  lastChannel: number | null
  lastFrequency: number | null
  gainDb: number | null
  sampleRate: number | null
  /** RTL2832U DSP front-end strategy (see `RtlFrontendMode`). */
  frontend: RtlFrontendMode
  /** Playback jitter buffer depth in seconds; media is presented this far behind live. */
  bufferSeconds: number
  /** Run the OFDM front end on WebGPU when the browser exposes it. */
  webgpu: boolean
  ui: { theme?: 'dark' | 'light'; subtitles: boolean; audioChannel: AudioChannelMode }
  debug: { showOverlay: boolean }
}

/** Deep-partial patch accepted by `saveSettings`; nested `ui`/`debug` merge field-wise. */
export type SettingsPatch = Partial<Omit<AppSettings, 'ui' | 'debug'>> & {
  ui?: Partial<AppSettings['ui']>
  debug?: Partial<AppSettings['debug']>
}

export const SETTINGS_STORAGE_KEY = 'webisdb-rtl:settings'
export const DEFAULT_BUFFER_SECONDS = 3
export const MAX_BUFFER_SECONDS = 10

export function defaultSettings(): AppSettings {
  return {
    lastRegionId: null,
    lastChannel: null,
    lastFrequency: null,
    gainDb: null,
    sampleRate: null,
    frontend: RtlFrontendMode.Generic,
    bufferSeconds: DEFAULT_BUFFER_SECONDS,
    webgpu: false,
    ui: { subtitles: false, audioChannel: AudioChannelMode.Stereo },
    debug: { showOverlay: false },
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

function asBufferSeconds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.min(value, MAX_BUFFER_SECONDS)
}

function asTheme(value: unknown): 'dark' | 'light' | undefined {
  return value === 'dark' || value === 'light' ? value : undefined
}

function asFrontend(value: unknown, fallback: RtlFrontendMode): RtlFrontendMode {
  return value === RtlFrontendMode.RealtekIsdbt || value === RtlFrontendMode.Generic
    ? value
    : fallback
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
    frontend: asFrontend(patch.frontend, base.frontend),
    bufferSeconds: asBufferSeconds(patch.bufferSeconds, base.bufferSeconds),
    webgpu: asBoolean(patch.webgpu, base.webgpu),
    ui: {
      ...base.ui,
      ...(theme === undefined ? {} : { theme }),
      subtitles: asBoolean(ui.subtitles, base.ui.subtitles),
      audioChannel: audioChannel ?? base.ui.audioChannel,
    },
    debug: { showOverlay: asBoolean(debug.showOverlay, base.debug.showOverlay) },
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
