/**
 * Main-thread orchestration: owns the receiver/TS workers, the (main-thread)
 * WebUSB IQ source, the media player, and mirrors everything into the app store.
 */
import { channelToFrequencyHz, frequencyToChannel } from '../models/channel'
import type { IQSource } from '../iq/IQSource'
import { RTLSDRSource } from '../iq/RTLSDRSource'
import { ISDBT_RTL_SAMPLE_RATE, RtlFrontendMode } from '../driver/rtlsdr/rtl2832u'
import { findAuthorizedRtlSdrDevice, requestRtlSdrDevice } from '../driver/rtlsdr/usbTransport'
import type { UsbTransport, WebUsbTransport } from '../driver/rtlsdr/usbTransport'
import type { OneSegPlayer, PlayerStats } from '../media/player'
import type {
  IqChunkInit,
  ReceiverCommand,
  ReceiverEvent,
  TsCommand,
  TsEvent,
} from '../workers/protocol'
import { createEmptyDiagnostics, store } from './store'
import { reportError } from './notifications'
import { loadSettings, saveSettings } from '../storage/settings'
import { receivedServices } from './serviceInfo'

const DEFAULT_SAMPLE_RATE = 1_200_000
const DEFAULT_GAIN = 19.7

/** RTL-SDR hardware rate implied by the selected front-end mode. */
function desiredSampleRate(settings = loadSettings()): number {
  return settings.frontend === RtlFrontendMode.RealtekIsdbt
    ? ISDBT_RTL_SAMPLE_RATE
    : (settings.sampleRate ?? DEFAULT_SAMPLE_RATE)
}

export interface ReceiverControllerOptions {
  player?: OneSegPlayer | null
}

export class ReceiverController {
  #receiverWorker: Worker | null = null
  #tsWorker: Worker | null = null
  #source: IQSource | null = null
  #player: OneSegPlayer | null
  #unsubscribeSamples: (() => void) | null = null
  #unsubscribeState: (() => void) | null = null
  #started = false
  #tuneTargetHz: number | null = null
  #tuneTask: Promise<void> = Promise.resolve()
  #tuning = false
  #connectTask: Promise<void> | null = null

  constructor(options: ReceiverControllerOptions = {}) {
    this.#player = options.player ?? null
  }

  setPlayer(player: OneSegPlayer | null): void {
    this.#player = player
  }

  /** Latest decoder statistics, or null while no player is attached. */
  get playerStats(): PlayerStats | null {
    return this.#player?.stats ?? null
  }

  // --- lifecycle -----------------------------------------------------------

  #ensureWorkers(): { receiver: Worker; ts: Worker } {
    if (!this.#receiverWorker) {
      this.#receiverWorker = new Worker(new URL('../workers/receiver.worker.ts', import.meta.url), {
        type: 'module',
      })
      const worker = this.#receiverWorker
      this.#receiverWorker.onmessage = (event: MessageEvent<ReceiverEvent>) => {
        if (this.#receiverWorker === worker) this.#handleReceiverEvent(event.data)
      }
      this.#receiverWorker.onerror = (event) => this.#fail(event.error ?? event.message)
    }
    if (!this.#tsWorker) {
      this.#tsWorker = new Worker(new URL('../workers/ts.worker.ts', import.meta.url), {
        type: 'module',
      })
      const worker = this.#tsWorker
      this.#tsWorker.onmessage = (event: MessageEvent<TsEvent>) => {
        if (this.#tsWorker === worker) this.#handleTsEvent(event.data)
      }
      this.#tsWorker.onerror = (event) => this.#fail(event.error ?? event.message)
    }
    return { receiver: this.#receiverWorker, ts: this.#tsWorker }
  }

  #postReceiver(command: ReceiverCommand, transfer?: Transferable[]): void {
    const { receiver } = this.#ensureWorkers()
    receiver.postMessage(command, transfer ?? [])
  }

  #postTs(command: TsCommand, transfer?: Transferable[]): void {
    const { ts } = this.#ensureWorkers()
    ts.postMessage(command, transfer ?? [])
  }

  // --- sources -------------------------------------------------------------

  async connectRtlSdr(transport?: UsbTransport): Promise<void> {
    // WebUSB device state changes (open/selectConfiguration/claimInterface) must
    // not overlap. React StrictMode and rapid UI actions can invoke this twice,
    // so coalesce every concurrent request into a single connection attempt.
    if (this.#connectTask) return this.#connectTask
    const task = this.performConnect(transport)
    this.#connectTask = task
    try {
      await task
    } finally {
      if (this.#connectTask === task) this.#connectTask = null
    }
  }

  private async performConnect(transport?: UsbTransport): Promise<void> {
    const settings = loadSettings()
    await this.#detachSource()
    const usbTransport = transport ?? (await requestRtlSdrDevice())
    const configured = store.getState().configuredChannels
    const fallbackChannel = settings.lastChannel ?? configured[0]?.physicalChannel ?? 19
    const source = new RTLSDRSource(usbTransport, {
      sampleRate: desiredSampleRate(settings),
      centerFrequency: settings.lastFrequency ?? channelToFrequencyHz(fallbackChannel),
      gainDb: settings.gainDb ?? DEFAULT_GAIN,
    })
    try {
      await source.open()
    } catch (error) {
      await source.close().catch(() => undefined)
      await usbTransport.close().catch(() => undefined)
      throw error
    }
    this.#attachSource(source)
    store.setState((prev) => ({
      receiver: {
        ...prev.receiver,
        sourceKind: 'rtlsdr',
        label: source.descriptor.label,
        state: 'running',
        sampleRate: source.descriptor.sampleRate,
        frequency: source.descriptor.centerFrequency,
        channel: frequencyToChannel(source.descriptor.centerFrequency),
        gainDb: settings.gainDb ?? DEFAULT_GAIN,
        error: null,
      },
    }))
    this.#postReceiver({
      type: 'init',
      options: {
        source: { kind: 'rtlsdr', deviceLabel: source.descriptor.label },
        frequency: source.descriptor.centerFrequency,
        sampleRate: source.descriptor.sampleRate,
        gainDb: settings.gainDb ?? DEFAULT_GAIN,
        ppm: 0,
        spectrumEnabled: false,
      },
    })
    await source.start()
    this.#started = source.state === 'running'
  }

  /**
   * Reconnect to an already-authorized RTL-SDR without a user gesture and tune
   * the last watched channel. Returns false when no authorized device exists.
   */
  async autoConnectRtlSdr(): Promise<boolean> {
    if (this.#started) return true
    let transport: WebUsbTransport | null = null
    try {
      transport = await findAuthorizedRtlSdrDevice()
    } catch {
      return false
    }
    if (!transport) return false
    try {
      await this.connectRtlSdr(transport)
      return true
    } catch {
      return false
    }
  }

  #attachSource(source: IQSource): void {
    this.#source = source
    this.#unsubscribeSamples = source.onSamples(
      (chunk) => {
        if (chunk.endOfStream) return
        const buffer = (chunk.data as Uint8Array).buffer as ArrayBuffer
        const init: IqChunkInit = {
          data: buffer,
          format: chunk.format,
          sampleRate: chunk.sampleRate,
          centerFrequency: chunk.centerFrequency,
          sequence: chunk.sequence,
          timestamp: chunk.timestamp,
        }
        this.#postReceiver({ type: 'iqChunk', chunk: init }, [buffer])
      },
      { transfer: true },
    )
    this.#unsubscribeState = source.onStateChange((state) => {
      store.setState((prev) => ({ receiver: { ...prev.receiver, state } }))
    })
  }

  async #detachSource(): Promise<void> {
    this.#unsubscribeSamples?.()
    this.#unsubscribeState?.()
    this.#unsubscribeSamples = null
    this.#unsubscribeState = null
    const source = this.#source
    this.#source = null
    if (source) await source.close().catch(() => undefined)
    this.#resetWorkers()
    this.#player?.reset()
    store.setState({ diagnostics: createEmptyDiagnostics() })
  }

  #resetWorkers(): void {
    this.#receiverWorker?.terminate()
    this.#tsWorker?.terminate()
    this.#receiverWorker = null
    this.#tsWorker = null
  }

  // --- controls ------------------------------------------------------------

  async tunePhysicalChannel(channel: number): Promise<void> {
    await this.tuneFrequency(channelToFrequencyHz(channel))
    saveSettings({ lastChannel: channel, lastFrequency: channelToFrequencyHz(channel) })
  }

  /**
   * Queue a tune. Requests made while a tune is in flight are coalesced so the
   * worker/hardware teardown of one channel can never interleave with the setup
   * of another.
   */
  tuneFrequency(hz: number): Promise<void> {
    this.#tuneTargetHz = hz
    if (!this.#tuning) {
      this.#tuning = true
      this.#tuneTask = this.#runTuneLoop()
    }
    return this.#tuneTask
  }

  async #runTuneLoop(): Promise<void> {
    try {
      while (this.#tuneTargetHz !== null) {
        const hz = this.#tuneTargetHz
        this.#tuneTargetHz = null
        try {
          await this.#applyTune(hz)
        } catch (error) {
          this.#fail(error)
        }
      }
    } finally {
      this.#tuning = false
    }
  }

  async #applyTune(hz: number): Promise<void> {
    const source = this.#source
    const restart = source?.state === 'running'
    if (source) {
      await source.stop()
      await source.setFrequency(hz)
      this.#resetWorkers()
    }
    store.setState((prev) => ({
      receiver: { ...prev.receiver, frequency: hz, channel: frequencyToChannel(hz) },
      diagnostics: createEmptyDiagnostics(),
    }))
    this.#postTs({ type: 'reset' })
    if (source) {
      const receiver = store.getState().receiver
      this.#postReceiver({
        type: 'init',
        options: {
          source: { kind: 'rtlsdr', deviceLabel: source.descriptor.label },
          frequency: hz,
          sampleRate: source.descriptor.sampleRate,
          gainDb: receiver.gainDb ?? 'auto',
          ppm: receiver.ppm,
          spectrumEnabled: false,
        },
      })
      if (restart) await source.start()
    } else {
      this.#postReceiver({ type: 'tune', frequency: hz })
    }
    this.#player?.reset()
  }

  start(): void {
    this.#postReceiver({ type: 'start' })
    void this.#source?.start().catch((error: unknown) => this.#fail(error))
    this.#started = true
  }

  stop(): void {
    this.#postReceiver({ type: 'stop' })
    void this.#source?.stop()
    this.#started = false
  }

  selectService(serviceId: number | null): void {
    this.#player?.reset()
    if (serviceId !== null) this.#postTs({ type: 'selectService', serviceId })
    store.setState((prev) => ({
      diagnostics: { ...prev.diagnostics, selectedServiceId: serviceId },
    }))
  }

  setSpectrumEnabled(enabled: boolean): void {
    this.#postReceiver({ type: 'setSpectrumEnabled', enabled })
  }

  setGain(gainDb: number | 'auto'): void {
    void this.#source?.setGain(gainDb)
    saveSettings({ gainDb: typeof gainDb === 'number' ? gainDb : null })
    store.setState((prev) => ({
      receiver: { ...prev.receiver, gainDb: typeof gainDb === 'number' ? gainDb : null },
    }))
  }

  /**
   * Switch the DSP front-end strategy (generic resampler vs Realtek ISDB-T
   * 2:1 decimation) and reconfigure the live source so it takes effect without
   * a manual reconnect.
   */
  async setFrontend(mode: RtlFrontendMode): Promise<void> {
    saveSettings({ frontend: mode })
    await this.#reconfigureFrontend()
  }

  /** Change the generic-mode sample rate and reconfigure the live source. */
  async setSampleRate(hz: number): Promise<void> {
    saveSettings({ sampleRate: hz })
    if (loadSettings().frontend === RtlFrontendMode.Generic) await this.#reconfigureFrontend()
  }

  async #reconfigureFrontend(): Promise<void> {
    const source = this.#source
    if (!source || source.kind !== 'rtlsdr') return
    const restart = source.state === 'running'
    const rate = desiredSampleRate()
    try {
      await source.stop()
      if (rate !== source.descriptor.sampleRate) await source.setSampleRate(rate)
      this.#resetWorkers()
      store.setState((prev) => ({
        receiver: { ...prev.receiver, sampleRate: source.descriptor.sampleRate },
        diagnostics: createEmptyDiagnostics(),
      }))
      this.#postTs({ type: 'reset' })
      const receiver = store.getState().receiver
      this.#postReceiver({
        type: 'init',
        options: {
          source: { kind: 'rtlsdr', deviceLabel: source.descriptor.label },
          frequency: source.descriptor.centerFrequency,
          sampleRate: source.descriptor.sampleRate,
          gainDb: receiver.gainDb ?? 'auto',
          ppm: receiver.ppm,
          spectrumEnabled: false,
        },
      })
      if (restart) await source.start()
      this.#player?.reset()
      this.#started = source.state === 'running'
    } catch (error) {
      this.#fail(error)
    }
  }

  get running(): boolean {
    return this.#started
  }

  dispose(): void {
    void this.#detachSource()
    this.#receiverWorker?.terminate()
    this.#tsWorker?.terminate()
    this.#receiverWorker = null
    this.#tsWorker = null
  }

  // --- event handling ------------------------------------------------------

  #handleReceiverEvent(event: ReceiverEvent): void {
    switch (event.type) {
      case 'state':
        store.setState((prev) => ({ receiver: { ...prev.receiver, state: event.state } }))
        break
      case 'stats':
        store.setState((prev) => ({ receiver: { ...prev.receiver, stats: event.stats } }))
        break
      case 'spectrum':
        store.setState({ spectrum: event.spectrum })
        break
      case 'tmcc':
        store.setState((prev) => ({ diagnostics: { ...prev.diagnostics, tmcc: event.tmcc } }))
        break
      case 'ts':
        this.#postTs({ type: 'input', data: event.data }, [event.data.buffer])
        break
      case 'error':
        this.#fail(event.error)
        break
      default:
        break
    }
  }

  #handleTsEvent(event: TsEvent): void {
    switch (event.type) {
      case 'pat':
        store.setState((prev) => ({ diagnostics: { ...prev.diagnostics, pat: event.section } }))
        break
      case 'pmt':
        store.setState((prev) => {
          const diagnostics = { ...prev.diagnostics, pmt: event.section }
          return {
            diagnostics: {
              ...diagnostics,
              services: receivedServices(diagnostics),
              selectedServiceId: diagnostics.selectedServiceId ?? event.section.programNumber,
            },
          }
        })
        break
      case 'sdt': {
        store.setState((prev) => {
          const diagnostics = { ...prev.diagnostics, sdt: event.section }
          return { diagnostics: { ...diagnostics, services: receivedServices(diagnostics) } }
        })
        break
      }
      case 'eit':
        store.setState((prev) => ({ diagnostics: { ...prev.diagnostics, eit: event.section } }))
        break
      case 'nit':
        store.setState((prev) => ({ diagnostics: { ...prev.diagnostics, nit: event.section } }))
        break
      case 'tdt':
        store.setState((prev) => ({ diagnostics: { ...prev.diagnostics, tdt: event.section } }))
        break
      case 'tot':
        store.setState((prev) => ({ diagnostics: { ...prev.diagnostics, tot: event.section } }))
        break
      case 'statistics':
        store.setState((prev) => ({
          diagnostics: { ...prev.diagnostics, tsStatistics: event.statistics },
        }))
        break
      case 'pes': {
        const kind = event.packet.kind
        const key =
          kind === 'video' || kind === 'audio' || kind === 'caption' || kind === 'data'
            ? kind
            : null
        if (key) {
          store.setState((prev) => ({
            diagnostics: {
              ...prev.diagnostics,
              pesCounts: {
                ...prev.diagnostics.pesCounts,
                [key]: prev.diagnostics.pesCounts[key] + 1,
              },
            },
          }))
        }
        this.#player?.pushPes(event.packet)
        break
      }
      case 'error':
        this.#fail(event.error)
        break
      default:
        break
    }
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    reportError('receiver', error)
    store.setState((prev) => ({ receiver: { ...prev.receiver, state: 'error', error: message } }))
  }
}

export const receiverController = new ReceiverController()
