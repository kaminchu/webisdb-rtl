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

export interface IqSubscriptionOptions {
  /**
   * Request ownership of `chunk.data.buffer` for this subscriber. A source only
   * honors it while this is the sole subscriber with an exactly-covering buffer;
   * otherwise it delivers a private whole-buffer copy so a transfer cannot detach
   * data another subscriber (or the source itself) still reads.
   *
   * Once honored, the subscriber owns the buffer; the source must not read or
   * reuse the chunk after the callback returns.
   */
  transfer?: boolean
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
   * Subscribe to IQ chunks. Returns an unsubscribe function. With
   * `options.transfer` an exclusive subscriber receives a buffer it may transfer;
   * see `IqSubscriptionOptions`.
   */
  onSamples(cb: (chunk: IqChunk) => void, options?: IqSubscriptionOptions): () => void

  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onStateChange(cb: (state: IQSourceState) => void): () => void
}

/** True when `data` exactly covers its backing buffer, so the buffer can be transferred whole. */
export function isTransferableBuffer(data: ArrayBufferView): boolean {
  return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
}

/**
 * Deliver one chunk to every sink, honoring the transfer contract: a subscriber
 * that requested ownership gets the original buffer only when it is the sole
 * sink and the chunk covers the whole buffer; otherwise it receives a copy.
 */
export function deliverIqChunk(
  sinks: ReadonlyMap<(chunk: IqChunk) => void, boolean>,
  chunk: IqChunk,
): void {
  const transferable = sinks.size === 1 && isTransferableBuffer(chunk.data)
  for (const [cb, wantsTransfer] of sinks) {
    if (wantsTransfer && !transferable) {
      cb({ ...chunk, data: chunk.data.slice() as IqChunk['data'] })
    } else {
      cb(chunk)
    }
  }
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
