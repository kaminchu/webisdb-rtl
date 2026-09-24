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
    if (task) await task.catch(() => undefined)
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
    if (this.currentState !== 'open') return
    this.setState('starting')
    this.running = true
    this.sequence = 0
    await this.rtl?.resetBuffer()
    this.setState('running')
    this.readTask = this.readLoop()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.setState('stopping')
    const task = this.readTask
    this.readTask = null
    if (task) await task.catch(() => {})
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

  private async readLoop(): Promise<void> {
    while (this.running) {
      let data: Uint8Array
      try {
        data = await this.transport.bulkIn(RTL_BULK_ENDPOINT, this.transferSize)
      } catch (error) {
        if (this.running) this.fail(error)
        return
      }
      if (!this.running) return
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
