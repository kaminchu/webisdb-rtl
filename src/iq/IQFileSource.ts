/**
 * IQ file source (要件定義書 34). Emits recorded raw IQ as `IqChunk`s so the DSP
 * chain can run without a tuner attached, enabling deterministic regression tests.
 */
import type {
  IQSource,
  IQSourceDescriptor,
  IQSourceKind,
  IQSourceState,
  IqChunk,
  IqSampleFormat,
} from './IQSource'
import type { IqMetadata } from './iqFormat'

const DEFAULT_CHUNK_SAMPLES = 16384

export interface IQFileSourceOptions {
  /**
   * When true, pace emission to the nominal sample rate (playback). When false
   * (default), emit as fast as possible (analysis / regression).
   */
  realtime?: boolean
  /** Complex samples per emitted chunk. */
  chunkSamples?: number
  label?: string
}

export class IQFileSource implements IQSource {
  readonly kind: IQSourceKind = 'iq-file'

  private readonly bytes: Uint8Array
  private readonly metadata: IqMetadata
  private readonly options: Required<Omit<IQFileSourceOptions, 'label'>>
  private readonly label: string
  private readonly bytesPerSample = 2

  private currentState: IQSourceState = 'closed'
  private running = false
  private sequence = 0
  private readOffset = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private pacedStart = 0
  private pacedEmitted = 0

  private readonly sampleCallbacks = new Set<(chunk: IqChunk) => void>()
  private readonly stateCallbacks = new Set<(state: IQSourceState) => void>()

  constructor(
    data: Uint8Array | ArrayBuffer,
    metadata: IqMetadata,
    options: IQFileSourceOptions = {},
  ) {
    this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    this.metadata = metadata
    this.options = {
      realtime: options.realtime ?? false,
      chunkSamples: options.chunkSamples ?? DEFAULT_CHUNK_SAMPLES,
    }
    this.label = options.label ?? 'IQ ファイル'
  }

  get descriptor(): IQSourceDescriptor {
    return {
      kind: this.kind,
      label: this.label,
      sampleRate: this.metadata.sampleRate,
      centerFrequency: this.metadata.centerFrequency,
    }
  }

  get state(): IQSourceState {
    return this.currentState
  }

  get totalSamples(): number {
    return Math.floor(this.bytes.length / this.bytesPerSample)
  }

  private setState(state: IQSourceState): void {
    if (this.currentState === state) return
    this.currentState = state
    for (const cb of this.stateCallbacks) cb(state)
  }

  async open(): Promise<void> {
    if (this.currentState !== 'closed') return
    this.setState('opening')
    this.readOffset = 0
    this.sequence = 0
    if (this.bytes.length % 2 !== 0) {
      this.setState('error')
      throw new Error('IQ file length must be a multiple of 2 (U8 I/Q pairs)')
    }
    this.setState('open')
  }

  async close(): Promise<void> {
    await this.stop()
    this.setState('closed')
  }

  async setFrequency(hz: number): Promise<void> {
    this.metadata.centerFrequency = hz
  }

  async setSampleRate(hz: number): Promise<void> {
    this.metadata.sampleRate = hz
  }

  async setGain(): Promise<void> {
    // File sources have no tuner.
  }

  async start(): Promise<void> {
    if (this.running) return
    if (this.currentState === 'closed') await this.open()
    this.running = true
    this.setState('running')
    this.pacedStart = Date.now()
    this.pacedEmitted = 0
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.currentState === 'running') this.setState('open')
  }

  onSamples(cb: (chunk: IqChunk) => void): () => void {
    this.sampleCallbacks.add(cb)
    return () => this.sampleCallbacks.delete(cb)
  }

  onStateChange(cb: (state: IQSourceState) => void): () => void {
    this.stateCallbacks.add(cb)
    return () => this.stateCallbacks.delete(cb)
  }

  private schedule(delayMs: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      try {
        this.emitAvailable()
      } catch (error) {
        this.setState('error')
        console.error('[IQFileSource]', error)
      }
      if (!this.running) return
      if (this.readOffset >= this.bytes.length) {
        this.running = false
        this.setState('open')
        this.emitEnd()
        return
      }
      this.schedule(this.nextDelay())
    }, delayMs)
  }

  private emitAvailable(): number {
    const { realtime, chunkSamples } = this.options
    const total = this.totalSamples
    let emitted = 0
    while (this.readOffset / this.bytesPerSample < total) {
      const start = this.readOffset
      const end = Math.min(start + chunkSamples * this.bytesPerSample, this.bytes.length)
      const data = this.bytes.subarray(start, end)
      this.readOffset = end
      const format: IqSampleFormat = this.metadata.format
      const chunk: IqChunk = {
        data,
        format,
        sampleRate: this.metadata.sampleRate,
        centerFrequency: this.metadata.centerFrequency,
        sequence: this.sequence++,
        timestamp: realtime
          ? Date.now() - this.pacedStart
          : (start / this.bytesPerSample / this.metadata.sampleRate) * 1000,
      }
      for (const cb of this.sampleCallbacks) cb(chunk)
      emitted++
      if (realtime) break
      if (emitted >= 8) break
    }
    this.pacedEmitted += emitted * chunkSamples
    return emitted
  }

  private nextDelay(): number {
    if (!this.options.realtime) return 0
    const targetMs = (this.pacedEmitted / this.metadata.sampleRate) * 1000
    const elapsed = Date.now() - this.pacedStart
    return Math.max(0, targetMs - elapsed)
  }

  private emitEnd(): void {
    const chunk: IqChunk = {
      data: new Uint8Array(0),
      format: this.metadata.format,
      sampleRate: this.metadata.sampleRate,
      centerFrequency: this.metadata.centerFrequency,
      sequence: this.sequence++,
      timestamp: Date.now() - this.pacedStart,
      endOfStream: true,
    }
    for (const cb of this.sampleCallbacks) cb(chunk)
  }
}
