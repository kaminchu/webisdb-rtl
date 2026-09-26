/**
 * Receiver worker (要件定義書 15): owns the one-seg DSP pipeline.
 *
 * For `iq-file` the worker reads and runs the file directly. For `rtlsdr` the
 * WebUSB device is owned by the main thread (browser user-gesture / object
 * lifetime constraints) and IQ chunks are streamed here for processing.
 */
/// <reference lib="webworker" />
import type { IqChunk } from '../iq/IQSource'
import { IQFileSource } from '../iq/IQFileSource'
import { OneSegPipeline, type OneSegPipelineStats } from '../dsp/pipeline'
import { WasmFftBackend } from '../dsp/wasm/fft'
import { requestWebGpuDevice } from '../dsp/gpu/webgpu'
import { powerSpectrumDb } from '../dsp/stages/spectrum'
import { emptyBufferMetrics, emptyReceptionQuality, emptyThroughput } from '../models/reception'
import type { ReceiverStats } from '../models'
import type { ReceiverCommand, ReceiverEvent, WorkerError } from './protocol'

const ctx = self as unknown as DedicatedWorkerGlobalScope

const SPECTRUM_FFT = 1024
const SPECTRUM_INTERVAL_MS = 100

class RateMeter {
  private total = 0
  private windowStart = performance.now()
  private windowTotal = 0

  add(n: number): void {
    this.total += n
    this.windowTotal += n
  }

  peek(): number {
    const now = performance.now()
    const elapsed = (now - this.windowStart) / 1000
    if (elapsed <= 0) return 0
    return this.windowTotal / elapsed
  }

  tick(): number {
    const rate = this.peek()
    this.windowStart = performance.now()
    this.windowTotal = 0
    return rate
  }

  get totalValue(): number {
    return this.total
  }
}

let pipeline: OneSegPipeline | null = null
let fileSource: IQFileSource | null = null
let gpuDevice: GPUDevice | null = null
let gpuAttempted = false
let webgpuEnabled = false
let spectrumEnabled = false
let lastSpectrumAt = 0
let inputSamples = 0
let inputSignalSeconds = 0
let lastStatsAt = performance.now()
let uptimeStart = performance.now()

const inputRate = new RateMeter()
const tsRate = new RateMeter()
const dspMs = new RateMeter()
const fft = new WasmFftBackend()
let lastStats: OneSegPipelineStats | null = null

function post(event: ReceiverEvent, transfer?: Transferable[]): void {
  ctx.postMessage(event, transfer ?? [])
}

function postError(error: unknown): void {
  const e = error instanceof Error ? error : new Error(String(error))
  const payload: WorkerError = { message: e.message, stack: e.stack }
  post({ type: 'error', error: payload })
}

function buildStats(now: number): ReceiverStats {
  const bufferedSamples = lastStats?.bufferedSamples ?? 0
  const inputSps = inputRate.peek()
  const elapsed = Math.max(0.001, (now - lastStatsAt) / 1000)
  const quality = lastStats?.quality ?? emptyReceptionQuality
  const processingMsPerInputSecond =
    inputSignalSeconds > 0 ? dspMs.totalValue / inputSignalSeconds : 0
  const stageSeconds = Math.max(0.001, lastStats?.inputSignalSeconds ?? inputSignalSeconds)
  const stagePerSecond = (ms: number | undefined): number => (ms ?? 0) / stageSeconds
  return {
    quality,
    throughput: {
      ...emptyThroughput,
      iqSamplesPerSecond: inputSps,
      tsBytesPerSecond: tsRate.peek(),
      dspUtilization: inputSignalSeconds > 0 ? Math.min(2, dspMs.peek() / 1000) : 0,
      dspProcessingMsPerSecond: processingMsPerInputSecond,
      realTimeFactor: processingMsPerInputSecond / 1000,
      frontendPath: lastStats?.frontendPath ?? emptyThroughput.frontendPath,
      stages: {
        preprocessMsPerSecond: stagePerSecond(lastStats?.preprocessMs),
        frontendMsPerSecond: stagePerSecond(lastStats?.frontendMs),
        decoderMsPerSecond: stagePerSecond(lastStats?.decoderMs),
        acquisitionMsPerSecond: stagePerSecond(lastStats?.acquisitionMs),
        gpuBatchMsPerSecond: stagePerSecond(lastStats?.gpuBatchMs),
        gpuReadbackMsPerSecond: stagePerSecond(lastStats?.gpuReadbackMs),
      },
      acquisitionCount: lastStats?.acquisitionCount ?? 0,
      lockLossCount: lastStats?.lockLossCount ?? 0,
    },
    buffer: {
      ...emptyBufferMetrics,
      bufferedSamples,
      bufferedBytes: bufferedSamples * 2,
      occupancy: Math.min(1, bufferedSamples / (inputSps * elapsed * 2 || 1)),
      estimatedDelaySeconds: inputSps > 0 ? bufferedSamples / inputSps : 0,
      inputSamplesPerSecond: inputSps,
      dspSamplesPerSecond: lastStats?.state === 'locked' ? inputSps : 0,
    },
    uptimeSeconds: (now - uptimeStart) / 1000,
  }
}

function emitStats(now: number): void {
  post({ type: 'stats', stats: buildStats(now) })
}

function maybeEmitSpectrum(chunk: IqChunk, now: number): void {
  if (!spectrumEnabled || now - lastSpectrumAt < SPECTRUM_INTERVAL_MS) return
  lastSpectrumAt = now
  if (chunk.format !== 'u8' || !(chunk.data instanceof Uint8Array)) return
  if (chunk.data.length < SPECTRUM_FFT * 2) return
  const floats = new Float32Array(SPECTRUM_FFT * 2)
  for (let i = 0; i < floats.length; i++) floats[i] = (chunk.data[i] - 127.5) / 127.5
  const bins = powerSpectrumDb(floats, SPECTRUM_FFT, fft)
  const copy = bins.slice()
  post(
    {
      type: 'spectrum',
      spectrum: {
        bins: copy,
        binHz: chunk.sampleRate / SPECTRUM_FFT,
        centerFrequency: chunk.centerFrequency,
        sampleRate: chunk.sampleRate,
      },
    },
    [copy.buffer],
  )
}

function ensurePipeline(options?: { sampleRate?: number }): OneSegPipeline {
  if (pipeline) return pipeline
  pipeline = new OneSegPipeline(
    {
      onTs: (bytes) => {
        tsRate.add(bytes.length)
        // `bytes` is a freshly allocated copy of the WASM output, so its whole
        // buffer can be transferred without an extra defensive slice.
        post({ type: 'ts', data: bytes }, [bytes.buffer])
      },
      onTmcc: (info) => post({ type: 'tmcc', tmcc: info }),
      onStats: (stats) => {
        lastStats = stats
        const now = performance.now()
        if (now - lastStatsAt >= 500) {
          emitStats(now)
          lastStatsAt = now
          inputRate.tick()
          tsRate.tick()
          dspMs.tick()
        }
      },
      onState: (state) =>
        post({
          type: 'state',
          state: state === 'locked' ? 'running' : state === 'error' ? 'error' : 'running',
        }),
    },
    { sourceSampleRate: options?.sampleRate ?? 1_200_000, gpuDevice: gpuHandle() },
  )
  return pipeline
}

function gpuHandle(): GPUDevice | undefined {
  return webgpuEnabled ? (gpuDevice ?? undefined) : undefined
}

function handleInit(command: Extract<ReceiverCommand, { type: 'init' }>): void | Promise<void> {
  const { options } = command
  void fileSource?.stop()
  pipeline?.dispose()
  pipeline = null
  fileSource = null
  spectrumEnabled = options.spectrumEnabled ?? false
  lastSpectrumAt = 0
  inputRate.tick()
  tsRate.tick()
  dspMs.tick()
  lastStats = null
  inputSamples = 0
  inputSignalSeconds = 0
  uptimeStart = performance.now()
  lastStatsAt = performance.now()
  webgpuEnabled = options.webgpu ?? false

  if (options.source.kind === 'iq-file') {
    fileSource = new IQFileSource(new Uint8Array(options.source.data), {
      ...options.source.metadata,
      centerFrequency: options.frequency,
      sampleRate: options.sampleRate,
    })
    fileSource.onStateChange((state) => post({ type: 'state', state }))
    fileSource.onSamples((chunk) => {
      if (chunk.endOfStream) {
        void pipeline?.flush()
        return
      }
      const samples = Math.floor(chunk.data.length / 2)
      inputSamples += samples
      inputSignalSeconds += chunk.sampleRate > 0 ? samples / chunk.sampleRate : 0
      inputRate.add(samples)
      maybeEmitSpectrum(chunk, performance.now())
      const t0 = performance.now()
      pipeline?.pushIq(chunk)
      dspMs.add(performance.now() - t0)
    })
  }

  if (webgpuEnabled && gpuDevice === null && !gpuAttempted) {
    gpuAttempted = true
    return requestWebGpuDevice().then((device) => {
      gpuDevice = device
      if (!pipeline && webgpuEnabled) ensurePipeline({ sampleRate: options.sampleRate })
    })
  }
  ensurePipeline({ sampleRate: options.sampleRate })
}

const handlers: {
  [K in ReceiverCommand['type']]: (
    command: Extract<ReceiverCommand, { type: K }>,
  ) => void | Promise<void>
} = {
  init: handleInit,
  iqChunk: (command) => {
    const c = command.chunk
    const data =
      c.format === 'f32'
        ? new Float32Array(c.data)
        : c.format === 'i8'
          ? new Int8Array(c.data)
          : new Uint8Array(c.data)
    const chunk: IqChunk = {
      data,
      format: c.format,
      sampleRate: c.sampleRate,
      centerFrequency: c.centerFrequency,
      sequence: c.sequence,
      timestamp: c.timestamp,
    }
    const samples = Math.floor(data.length / 2)
    inputSamples += samples
    inputSignalSeconds += c.sampleRate > 0 ? samples / c.sampleRate : 0
    inputRate.add(samples)
    maybeEmitSpectrum(chunk, performance.now())
    const t0 = performance.now()
    try {
      pipeline?.pushIq(chunk)
    } catch (error) {
      // A corrupt chunk must not poison the pipeline permanently; drop buffered
      // state and let acquisition restart on the next samples.
      pipeline?.discardBuffer()
      postError(error)
    }
    dspMs.add(performance.now() - t0)
  },
  tune: () => {
    pipeline?.discardBuffer()
  },
  setSampleRate: (command) => {
    if (pipeline) {
      pipeline.dispose()
      pipeline = null
    }
    ensurePipeline({ sampleRate: command.sampleRate })
  },
  setGain: () => {},
  setPpm: () => {},
  start: () => {
    void fileSource?.start()
  },
  stop: () => {
    void fileSource?.stop()
    void pipeline?.flush()
  },
  close: () => {
    void fileSource?.stop()
    fileSource = null
    pipeline?.dispose()
    pipeline = null
  },
  setSpectrumEnabled: (command) => {
    spectrumEnabled = command.enabled
  },
}

ctx.onmessage = (event: MessageEvent<ReceiverCommand>) => {
  const command = event.data
  const handler = handlers[command.type] as
    | ((c: ReceiverCommand) => void | Promise<void>)
    | undefined
  if (!handler) {
    postError(new Error(`unknown receiver command: ${(command as { type: string }).type}`))
    return
  }
  try {
    void Promise.resolve(handler(command)).catch(postError)
  } catch (error) {
    postError(error)
  }
}

post({ type: 'state', state: 'closed' })
