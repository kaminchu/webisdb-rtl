/**
 * WebUSB RTL-SDR IQ source (要件定義書 11).
 *
 * Wraps `UsbTransport` + `Rtl2832u` + a `Tuner` behind the `IQSource` interface.
 * Bulk IN transfers are re-submitted in an async loop and emitted as U8 I/Q chunks.
 */
import type { IQSource, IQSourceDescriptor, IQSourceKind, IQSourceState, IqChunk } from './IQSource'
import type { UsbTransport } from '../driver/rtlsdr/usbTransport'
import { Rtl2832u, RTL_BULK_ENDPOINT } from '../driver/rtlsdr/rtl2832u'
import {
  applyProfileInit,
  createTuner,
  identifyDevice,
  type DeviceProfile,
} from '../driver/rtlsdr/deviceProfile'
import type { Tuner } from '../driver/rtlsdr/tuner/tuner'

const DEFAULT_SAMPLE_RATE = 1_200_000
const DEFAULT_TRANSFER_SIZE = 256 * 1024
const TRANSFERS_IN_FLIGHT = 8
const MAX_CONSECUTIVE_READ_FAILURES = 5
const READ_RETRY_DELAY_MS = 50
/** Bound on joining the read loop so a stalled USB transfer cannot block stop(). */
const READ_STOP_GRACE_MS = 500

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RTLSDRSourceOptions {
  sampleRate?: number
  centerFrequency?: number
  gainDb?: number | 'auto'
  ppm?: number
  transferSize?: number
  label?: string
}

export class RTLSDRSource implements IQSource {
  readonly kind: IQSourceKind = 'rtlsdr'

  private readonly transport: UsbTransport
  private readonly options: RTLSDRSourceOptions
  private rtl: Rtl2832u | null = null
  private tuner: Tuner | null = null
  private profile: DeviceProfile | null = null

  private currentState: IQSourceState = 'closed'
  private sampleRate: number
  private centerFrequency: number
  private gainDb: number | 'auto'
  private ppm: number
  private transferSize: number
  private label: string

  private running = false
  private session = 0
  private sequence = 0
  private readTask: Promise<void> | null = null
  private unsubscribeDisconnect: (() => void) | null = null

  private readonly sampleCallbacks = new Set<(chunk: IqChunk) => void>()
  private readonly stateCallbacks = new Set<(state: IQSourceState) => void>()

  constructor(transport: UsbTransport, options: RTLSDRSourceOptions = {}) {
    this.transport = transport
    this.options = options
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE
    this.centerFrequency = options.centerFrequency ?? 0
    this.gainDb = options.gainDb ?? 'auto'
    this.ppm = options.ppm ?? 0
    this.transferSize = options.transferSize ?? DEFAULT_TRANSFER_SIZE
    this.label = options.label ?? 'RTL-SDR'
  }

  get descriptor(): IQSourceDescriptor {
    return {
      kind: this.kind,
      label: this.label,
      sampleRate: this.sampleRate,
      centerFrequency: this.centerFrequency,
    }
  }

  get state(): IQSourceState {
    return this.currentState
  }

  async open(): Promise<void> {
    if (this.currentState !== 'closed') return
    this.setState('opening')
    try {
      this.profile = await identifyDevice(this.transport)
      this.label = this.options.label ?? `${this.profile.model} / ${this.profile.tuner}`
      this.rtl = new Rtl2832u(this.transport)
      this.tuner = createTuner(this.profile.tuner)

      await applyProfileInit(this.rtl, this.profile)
      await this.tuner.open(this.rtl)
      await this.rtl.setSampleRate(this.sampleRate, this.ppm)
      if (this.centerFrequency > 0) await this.tuner.setFrequency(this.rtl, this.centerFrequency)
      await this.tuner.setGain(this.rtl, this.gainDb)

      this.unsubscribeDisconnect = this.transport.onDisconnect(() => this.handleDisconnect())
      this.setState('open')
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  async close(): Promise<void> {
    this.running = false
    this.unsubscribeDisconnect?.()
    this.unsubscribeDisconnect = null
    if (this.rtl) {
      try {
        await this.rtl.close()
      } catch {
        // device may already be gone
      }
    }
    const task = this.readTask
    this.readTask = null
    if (task) await Promise.race([task.catch(() => undefined), delay(READ_STOP_GRACE_MS)])
    this.rtl = null
    this.tuner = null
    this.profile = null
    this.setState('closed')
  }

  async setFrequency(hz: number): Promise<void> {
    this.centerFrequency = hz
    if (this.rtl && this.tuner && this.currentState !== 'closed') {
      await this.tuner.setFrequency(this.rtl, hz)
    }
  }

  async setSampleRate(hz: number): Promise<void> {
    if (this.rtl) await this.rtl.setSampleRate(hz, this.ppm)
    this.sampleRate = hz
  }

  async setGain(gainDb: number | 'auto'): Promise<void> {
    this.gainDb = gainDb
    if (this.rtl && this.tuner && this.currentState !== 'closed') {
      await this.tuner.setGain(this.rtl, gainDb)
    }
  }

  async start(): Promise<void> {
    if (this.currentState !== 'open' || this.running) return
    this.setState('starting')
    this.running = true
    const session = ++this.session
    this.sequence = 0
    await this.rtl?.resetBuffer()
    if (!this.running || this.session !== session) return
    this.setState('running')
    this.readTask = this.readLoop(session)
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.setState('stopping')
    const task = this.readTask
    this.readTask = null
    // A stalled bulk transfer may never settle; do not await it indefinitely.
    if (task) await Promise.race([task.catch(() => undefined), delay(READ_STOP_GRACE_MS)])
    this.setState('open')
  }

  onSamples(cb: (chunk: IqChunk) => void): () => void {
    this.sampleCallbacks.add(cb)
    return () => this.sampleCallbacks.delete(cb)
  }

  onStateChange(cb: (state: IQSourceState) => void): () => void {
    this.stateCallbacks.add(cb)
    return () => this.stateCallbacks.delete(cb)
  }

  private async readLoop(session: number): Promise<void> {
    const read = async (): Promise<{ data?: Uint8Array; error?: unknown }> => {
      try {
        return { data: await this.transport.bulkIn(RTL_BULK_ENDPOINT, this.transferSize) }
      } catch (error) {
        return { error }
      }
    }
    // Keep the endpoint queued while JavaScript handles completed buffers; a single
    // outstanding transfer lets the device FIFO overflow between submissions.
    const pending: Array<Promise<{ data?: Uint8Array; error?: unknown }>> = []
    for (let i = 0; i < TRANSFERS_IN_FLIGHT; i++) pending.push(read())
    let failures = 0
    try {
      while (this.running && this.session === session) {
        const result = await pending.shift()!
        if (!this.running || this.session !== session) break
        if (!result.data) {
          // A single stalled/failed transfer is recoverable; only give up after
          // several consecutive failures.
          failures++
          if (failures >= MAX_CONSECUTIVE_READ_FAILURES) {
            this.running = false
            this.fail(result.error)
            break
          }
          await delay(READ_RETRY_DELAY_MS * failures)
          if (!this.running || this.session !== session) break
          pending.push(read())
          continue
        }
        failures = 0
        pending.push(read())
        const data = result.data
        if (data.length === 0) continue

        const chunk: IqChunk = {
          data,
          format: 'u8',
          sampleRate: this.sampleRate,
          centerFrequency: this.centerFrequency,
          sequence: this.sequence++,
          timestamp: performance.now(),
        }
        for (const cb of this.sampleCallbacks) cb(chunk)
      }
    } finally {
      // Outstanding transfers may never settle after a stall; discard them so a
      // superseded loop cannot emit stale chunks.
      for (const promise of pending) void promise.catch(() => undefined)
    }
  }

  private handleDisconnect(): void {
    this.running = false
    this.fail(new Error('RTL-SDR device disconnected'))
  }

  private fail(error: unknown): void {
    console.error('[RTLSDRSource]', error)
    this.setState('error')
  }

  private setState(state: IQSourceState): void {
    if (this.currentState === state) return
    this.currentState = state
    for (const cb of this.stateCallbacks) cb(state)
  }
}
