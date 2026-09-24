/**
 * Main-thread orchestration: owns the receiver/TS workers, the (main-thread)
 * WebUSB IQ source, the media player, and mirrors everything into the app store.
 */
import { channelToFrequencyHz, frequencyToChannel } from '../models/channel'
import type { IqMetadata } from '../iq/iqFormat'
import type { IQSource } from '../iq/IQSource'
import { RTLSDRSource } from '../iq/RTLSDRSource'
import { requestRtlSdrDevice } from '../driver/rtlsdr/usbTransport'
import type { OneSegPlayer } from '../media/player'
import type {
  IqChunkInit,
  ReceiverCommand,
  ReceiverEvent,
  TsCommand,
  TsEvent,
} from '../workers/protocol'
import { ByteRecorder } from '../dump/recorder'
import { downloadBytes, downloadText, timestampSlug } from '../dump/download'
import { createEmptyDiagnostics, store } from './store'
import { loadSettings, saveSettings } from '../storage/settings'

const DEFAULT_SAMPLE_RATE = 1_200_000
const DEFAULT_GAIN = 19.7

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
  #iqRecorder = new ByteRecorder()
  #tsRecorder = new ByteRecorder()
  #iqDumpEnabled = false
  #tsDumpEnabled = false

  constructor(options: ReceiverControllerOptions = {}) {
    this.#player = options.player ?? null
  }

  setPlayer(player: OneSegPlayer | null): void {
    this.#player = player
  }

  // --- lifecycle -----------------------------------------------------------

  #ensureWorkers(): { receiver: Worker; ts: Worker } {
    if (!this.#receiverWorker) {
      this.#receiverWorker = new Worker(new URL('../workers/receiver.worker.ts', import.meta.url), {
        type: 'module',
      })
      this.#receiverWorker.onmessage = (event: MessageEvent<ReceiverEvent>) =>
        this.#handleReceiverEvent(event.data)
      this.#receiverWorker.onerror = (event) => this.#fail(event.message)
    }
    if (!this.#tsWorker) {
      this.#tsWorker = new Worker(new URL('../workers/ts.worker.ts', import.meta.url), {
        type: 'module',
      })
      this.#tsWorker.onmessage = (event: MessageEvent<TsEvent>) => this.#handleTsEvent(event.data)
      this.#tsWorker.onerror = (event) => this.#fail(event.message)
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

  async connectRtlSdr(): Promise<void> {
    const settings = loadSettings()
    await this.#detachSource()
    const transport = await requestRtlSdrDevice()
    const source = new RTLSDRSource(transport, {
      sampleRate: settings.sampleRate ?? DEFAULT_SAMPLE_RATE,
      centerFrequency: settings.lastFrequency ?? channelToFrequencyHz(settings.lastChannel ?? 19),
      gainDb: settings.gainDb ?? DEFAULT_GAIN,
    })
    try {
      await source.open()
    } catch (error) {
      await source.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
      throw error
    }
    this.#attachSource(source)
    await source.start()
    this.#started = true
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
        spectrumEnabled: true,
      },
    })
  }

  async openIqFile(
    data: Uint8Array | ArrayBuffer,
    metadata: IqMetadata,
    label?: string,
  ): Promise<void> {
    await this.#detachSource()
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const buffer = bytes.slice().buffer as ArrayBuffer
    store.setState((prev) => ({
      receiver: {
        ...prev.receiver,
        sourceKind: 'iq-file',
        label: label ?? 'IQ ファイル',
        state: 'opening',
        sampleRate: metadata.sampleRate,
        frequency: metadata.centerFrequency,
        channel: frequencyToChannel(metadata.centerFrequency),
        error: null,
      },
    }))
    this.#postReceiver(
      {
        type: 'init',
        options: {
          source: { kind: 'iq-file', metadata, data: buffer },
          frequency: metadata.centerFrequency,
          sampleRate: metadata.sampleRate,
          gainDb: metadata.gainDb ?? 'auto',
          ppm: metadata.ppm,
          spectrumEnabled: true,
        },
      },
      [buffer],
    )
    this.#postReceiver({ type: 'start' })
    this.#started = true
  }

  #attachSource(source: IQSource): void {
    this.#source = source
    this.#unsubscribeSamples = source.onSamples((chunk) => {
      if (chunk.endOfStream) return
      const copy = (chunk.data as Uint8Array).slice()
      if (this.#iqDumpEnabled) this.#iqRecorder.push(copy)
      const init: IqChunkInit = {
        data: copy.buffer,
        format: chunk.format,
        sampleRate: chunk.sampleRate,
        centerFrequency: chunk.centerFrequency,
        sequence: chunk.sequence,
        timestamp: chunk.timestamp,
      }
      this.#postReceiver({ type: 'iqChunk', chunk: init }, [copy.buffer])
    })
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
  }

  // --- controls ------------------------------------------------------------

  async tunePhysicalChannel(channel: number): Promise<void> {
    await this.tuneFrequency(channelToFrequencyHz(channel))
    saveSettings({ lastChannel: channel, lastFrequency: channelToFrequencyHz(channel) })
  }

  async tuneFrequency(hz: number): Promise<void> {
    if (this.#source) await this.#source.setFrequency(hz)
    store.setState((prev) => ({
      receiver: { ...prev.receiver, frequency: hz, channel: frequencyToChannel(hz) },
      diagnostics: createEmptyDiagnostics(),
    }))
    this.#postTs({ type: 'reset' })
    this.#postReceiver({ type: 'tune', frequency: hz })
    this.#player?.reset()
  }

  start(): void {
    this.#postReceiver({ type: 'start' })
    this.#started = true
  }

  stop(): void {
    this.#postReceiver({ type: 'stop' })
    void this.#source?.stop()
    this.#started = false
  }

  discardBuffer(): void {
    this.#postReceiver({ type: 'discardBuffer' })
    this.#postTs({ type: 'reset' })
    this.#player?.reset()
    store.setState({ diagnostics: createEmptyDiagnostics() })
  }

  selectService(serviceId: number | null): void {
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

  get running(): boolean {
    return this.#started
  }

  // --- dump (要件定義書 33) -------------------------------------------------

  setIqDumpEnabled(enabled: boolean): void {
    this.#iqDumpEnabled = enabled
    if (!enabled) this.#iqRecorder.clear()
  }

  setTsDumpEnabled(enabled: boolean): void {
    this.#tsDumpEnabled = enabled
    if (!enabled) this.#tsRecorder.clear()
  }

  get dumpSizes(): { iqBytes: number; tsBytes: number } {
    return { iqBytes: this.#iqRecorder.byteLength, tsBytes: this.#tsRecorder.byteLength }
  }

  saveIqDump(): void {
    const stamp = timestampSlug()
    const base = `iq-${stamp}`
    const bytes = this.#iqRecorder.take()
    downloadBytes(`${base}.iq`, bytes)
    const receiver = store.getState().receiver
    const metadata: IqMetadata = {
      version: 1,
      format: 'u8',
      sampleRate: receiver.sampleRate,
      centerFrequency: receiver.frequency,
      gainDb: receiver.gainDb,
      ppm: receiver.ppm,
      timestamp: new Date().toISOString(),
      device: receiver.label,
      tuner: 'unknown',
      physicalChannel: receiver.channel ?? undefined,
    }
    downloadText(`${base}.iq.json`, JSON.stringify(metadata, null, 2))
  }

  saveTsDump(): void {
    const bytes = this.#tsRecorder.take()
    downloadBytes(`stream-${timestampSlug()}.ts`, bytes, 'video/mp2t')
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
        if (this.#tsDumpEnabled) this.#tsRecorder.push(event.data)
        this.#postTs({ type: 'input', data: event.data }, [event.data.buffer])
        break
      case 'error':
        this.#fail(event.error.message)
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
        store.setState((prev) => ({ diagnostics: { ...prev.diagnostics, pmt: event.section } }))
        break
      case 'sdt': {
        const services = event.section.services.map((s) => ({
          serviceId: s.serviceId,
          name: s.serviceName,
          providerName: s.providerName,
          serviceType: s.serviceType,
        }))
        store.setState((prev) => ({
          diagnostics: {
            ...prev.diagnostics,
            sdt: event.section,
            services,
            selectedServiceId: prev.diagnostics.selectedServiceId ?? services[0]?.serviceId ?? null,
          },
        }))
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
        this.#fail(event.error.message)
        break
      default:
        break
    }
  }

  #fail(message: string): void {
    store.setState((prev) => ({ receiver: { ...prev.receiver, state: 'error', error: message } }))
  }
}

export const receiverController = new ReceiverController()
