/**
 * Worker message protocol (要件定義書 15, 36).
 *
 * The same core modules are callable without a worker (unit tests), so this
 * protocol is a thin transport layer over pure functions/classes.
 */
import type { IQSourceState } from '../iq/IQSource'
import type { IqMetadata } from '../iq/iqFormat'
import type { ReceiverStats } from '../models'
import type { TmccInfo } from '../models/tmcc'
import type { PesPacket } from '../models/media'
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

export interface WorkerError {
  message: string
  stack?: string
}

// ---------------------------------------------------------------------------
// Receiver worker
// ---------------------------------------------------------------------------

export interface ReceiverInitOptions {
  source:
    | { kind: 'rtlsdr'; deviceLabel: string }
    | { kind: 'iq-file'; metadata: IqMetadata; data: ArrayBuffer }
  frequency: number
  sampleRate: number
  gainDb: number | 'auto'
  ppm: number
  /** Feed spectrum snapshots back to the UI. */
  spectrumEnabled?: boolean
}

/** Serialized IQ chunk sent to the receiver worker from the main thread. */
export interface IqChunkInit {
  data: ArrayBuffer
  format: 'u8' | 'i8' | 'f32'
  sampleRate: number
  centerFrequency: number
  sequence: number
  timestamp: number
}

export type ReceiverCommand =
  | { type: 'init'; options: ReceiverInitOptions }
  | { type: 'iqChunk'; chunk: IqChunkInit }
  | { type: 'tune'; frequency: number }
  | { type: 'setSampleRate'; sampleRate: number }
  | { type: 'setGain'; gainDb: number | 'auto' }
  | { type: 'setPpm'; ppm: number }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'close' }
  | { type: 'discardBuffer' }
  | { type: 'setSpectrumEnabled'; enabled: boolean }
  | { type: 'setDumpIq'; enabled: boolean }

export interface SpectrumSnapshot {
  /** Power per FFT bin in dB. */
  bins: Float32Array
  /** Bin frequency spacing in Hz. */
  binHz: number
  centerFrequency: number
  sampleRate: number
}

export type ReceiverEvent =
  | { type: 'state'; state: IQSourceState }
  | { type: 'stats'; stats: ReceiverStats }
  | { type: 'spectrum'; spectrum: SpectrumSnapshot }
  | { type: 'tmcc'; tmcc: TmccInfo }
  | { type: 'ts'; data: Uint8Array }
  | { type: 'iqDump'; data: Uint8Array }
  | { type: 'error'; error: WorkerError }

// ---------------------------------------------------------------------------
// TS worker
// ---------------------------------------------------------------------------

export type TsCommand =
  | { type: 'input'; data: Uint8Array }
  | { type: 'reset' }
  | { type: 'selectService'; serviceId: number }
  | { type: 'setDumpTs'; enabled: boolean }

export type TsEvent =
  | { type: 'pat'; section: PatSection }
  | { type: 'pmt'; section: PmtSection }
  | { type: 'sdt'; section: SdtSection }
  | { type: 'eit'; section: EitSection }
  | { type: 'nit'; section: NitSection }
  | { type: 'tdt'; section: TdtSection }
  | { type: 'tot'; section: TotSection }
  | { type: 'pes'; packet: PesPacket }
  | { type: 'statistics'; statistics: TsStatistics }
  | { type: 'error'; error: WorkerError }

/** Convenience: typing helper for worker postMessage calls. */
export function postEvent<T>(port: { postMessage: (message: T) => void }, event: T): void {
  port.postMessage(event)
}
