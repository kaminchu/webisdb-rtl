/**
 * IQ input abstraction (要件定義書 11).
 *
 * Hardware sources (RTLSDRSource) and test-file sources (IQFileSource) share this
 * interface so the whole DSP chain can be developed and regression-tested without
 * a tuner attached.
 */

/** Interleaved sample formats. `u8`/`i8` are I,Q pairs; `f32` is complex float I,Q. */
export type IqSampleFormat = 'u8' | 'i8' | 'f32'

export interface IqChunk {
  /** Raw interleaved samples: [I0, Q0, I1, Q1, ...]. */
  data: Uint8Array | Int8Array | Float32Array
  format: IqSampleFormat
  /** Sample rate in Hz (complex samples per second). */
  sampleRate: number
  /** Center frequency in Hz at the time of capture. */
  centerFrequency: number
  /** Monotonic sequence number, used to detect drops. */
  sequence: number
  /** Capture timestamp (performance.now() or file offset), milliseconds. */
  timestamp: number
  /** True when the source has no more data (file sources). */
  endOfStream?: boolean
}

export type IQSourceKind = 'rtlsdr' | 'iq-file'

export type IQSourceState =
  | 'closed'
  | 'opening'
  | 'open'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export interface IQSourceDescriptor {
  kind: IQSourceKind
  /** Human readable label for the UI. */
  label: string
  sampleRate: number
  centerFrequency: number
}

export interface IQSource {
  readonly kind: IQSourceKind
  readonly descriptor: IQSourceDescriptor
  readonly state: IQSourceState

  open(): Promise<void>
  close(): Promise<void>

  setFrequency(hz: number): Promise<void>
  setSampleRate(hz: number): Promise<void>

  /** Set tuner gain in dB, or 'auto' for AGC. File sources may ignore this. */
  setGain(gainDb: number | 'auto'): Promise<void>

  start(): Promise<void>
  stop(): Promise<void>

  /**
   * Subscribe to IQ chunks. Returns an unsubscribe function.
   * Implementations must not retain references to `chunk.data` after the callback
   * returns when the buffer is a Transferable.
   */
  onSamples(cb: (chunk: IqChunk) => void): () => void

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onStateChange(cb: (state: IQSourceState) => void): () => void
}

/** Samples (complex) per second for a given format and interleaved length. */
export function complexSampleCount(chunk: Pick<IqChunk, 'data' | 'format'>): number {
  const scalar = chunk.format === 'f32' ? 2 : 2
  return Math.floor(chunk.data.length / scalar)
}

/** Convert one IQ pair in U8 format (128 == 0) to normalized floats. */
export function u8PairToComplex(i: number, q: number): [number, number] {
  return [(i - 127.5) / 127.5, (q - 127.5) / 127.5]
}
