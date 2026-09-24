import { useSyncExternalStore } from 'react'
import type { IQSourceState, IQSourceKind } from '../iq/IQSource'
import type { ReceiverStats, Service } from '../models'
import type { TmccInfo } from '../models/tmcc'
import type {
  EitSection,
  NitSection,
  PatSection,
  PmtSection,
  SdtSection,
  TdtSection,
  TotSection,
  TsStatistics,
} from '../models/si'
import { emptyBufferMetrics, emptyReceptionQuality, emptyThroughput } from '../models'

export const Screen = {
  Watch: 'watch',
  Epg: 'epg',
  Scan: 'scan',
  Debug: 'debug',
  Settings: 'settings',
} as const

export type Screen = (typeof Screen)[keyof typeof Screen]

export interface ReceiverSlice {
  sourceKind: IQSourceKind | 'none'
  label: string
  state: IQSourceState
  /** Current center frequency in Hz. */
  frequency: number
  /** Current physical channel, if on the grid. */
  channel: number | null
  sampleRate: number
  gainDb: number | null
  ppm: number
  stats: ReceiverStats
  error: string | null
}

export interface DiagnosticsSlice {
  tmcc: TmccInfo | null
  pat: PatSection | null
  pmt: PmtSection | null
  sdt: SdtSection | null
  eit: EitSection | null
  nit: NitSection | null
  tdt: TdtSection | null
  tot: TotSection | null
  tsStatistics: TsStatistics | null
  services: Service[]
  selectedServiceId: number | null
  pesCounts: { video: number; audio: number; caption: number; data: number }
}

export interface SpectrumSlice {
  bins: Float32Array | null
  binHz: number
  centerFrequency: number
}

export interface AppState {
  screen: Screen
  receiver: ReceiverSlice
  diagnostics: DiagnosticsSlice
  spectrum: SpectrumSlice
  toast: string | null
}

export function createEmptyDiagnostics(): DiagnosticsSlice {
  return {
    tmcc: null,
    pat: null,
    pmt: null,
    sdt: null,
    eit: null,
    nit: null,
    tdt: null,
    tot: null,
    tsStatistics: null,
    services: [],
    selectedServiceId: null,
    pesCounts: { video: 0, audio: 0, caption: 0, data: 0 },
  }
}

export function createInitialState(): AppState {
  return {
    screen: Screen.Watch,
    receiver: {
      sourceKind: 'none',
      label: '未接続',
      state: 'closed',
      frequency: 0,
      channel: null,
      sampleRate: 1_200_000,
      gainDb: null,
      ppm: 0,
      stats: {
        quality: { ...emptyReceptionQuality },
        throughput: { ...emptyThroughput },
        buffer: { ...emptyBufferMetrics },
        uptimeSeconds: 0,
      },
      error: null,
    },
    diagnostics: createEmptyDiagnostics(),
    spectrum: { bins: null, binHz: 0, centerFrequency: 0 },
    toast: null,
  }
}

export class Store {
  #state: AppState
  #listeners = new Set<() => void>()

  constructor(initial: AppState = createInitialState()) {
    this.#state = initial
  }

  getState = (): AppState => this.#state

  setState = (patch: Partial<AppState> | ((prev: AppState) => Partial<AppState>)): void => {
    const next = typeof patch === 'function' ? patch(this.#state) : patch
    this.#state = { ...this.#state, ...next }
    for (const listener of this.#listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}

export const store = new Store()

/** React hook selecting a slice of app state. */
export function useStore<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  )
}
