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
import { TsFftBackend } from '../dsp/stages/fft'
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
}

let pipeline: OneSegPipeline | null = null
let fileSource: IQFileSource | null = null
let spectrumEnabled = false
let lastSpectrumAt = 0
let inputSamples = 0
let lastStatsAt = performance.now()
let uptimeStart = performance.now()

const inputRate = new RateMeter()
const tsRate = new RateMeter()
const dspMs = new RateMeter()
const fft = new TsFftBackend()
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
  return {
    quality,
    throughput: {
      ...emptyThroughput,
      iqSamplesPerSecond: inputSps,
      tsBytesPerSecond: tsRate.peek(),
      dspUtilization: inputSps > 0 ? Math.min(2, dspMs.peek() / 1000) : 0,
      dspProcessingMsPerSecond: dspMs.peek(),
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
        const copy = bytes.slice()
        post({ type: 'ts', data: copy }, [copy.buffer])
      },
      onTmcc: (info) => post({ type: 'tmcc', tmcc: info }),
      onStats: (stats) => {
        lastStats = stats
        const now = performance.now()
        if (now - lastStatsAt >= 500) {
          lastStatsAt = now
          inputRate.tick()
          tsRate.tick()
          dspMs.tick()
          emitStats(now)
        }
      },
      onState: (state) =>
        post({
          type: 'state',
          state: state === 'locked' ? 'running' : state === 'error' ? 'error' : 'running',
        }),
    },
    { sourceSampleRate: options?.sampleRate ?? 1_200_000 },
  )
  return pipeline
}

function handleInit(command: Extract<ReceiverCommand, { type: 'init' }>): void {
  const { options } = command
  pipeline?.reset()
  fileSource = null
  lastStats = null
  inputSamples = 0
  uptimeStart = performance.now()
  lastStatsAt = performance.now()
  ensurePipeline({ sampleRate: options.sampleRate })

  if (options.source.kind === 'iq-file') {
    fileSource = new IQFileSource(new Uint8Array(options.source.data), {
      ...options.source.metadata,
      centerFrequency: options.frequency,
      sampleRate: options.sampleRate,
    })
    fileSource.onStateChange((state) => post({ type: 'state', state }))
    fileSource.onSamples((chunk) => {
      inputSamples += Math.floor(chunk.data.length / 2)
      inputRate.add(Math.floor(chunk.data.length / 2))
      maybeEmitSpectrum(chunk, performance.now())
      pipeline?.pushIq(chunk)
    })
  }
}

const handlers: {
  [K in ReceiverCommand['type']]: (command: Extract<ReceiverCommand, { type: K }>) => void
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
    inputSamples += Math.floor(data.length / 2)
    inputRate.add(Math.floor(data.length / 2))
    maybeEmitSpectrum(chunk, performance.now())
    const t0 = performance.now()
    pipeline?.pushIq(chunk)
    dspMs.add(performance.now() - t0)
  },
  tune: () => {
    pipeline?.discardBuffer()
  },
  setSampleRate: (command) => {
    if (pipeline) {
      pipeline.reset()
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
    pipeline?.flush()
  },
  close: () => {
    void fileSource?.stop()
    fileSource = null
    pipeline?.reset()
    pipeline = null
  },
  discardBuffer: () => {
    pipeline?.discardBuffer()
  },
  setSpectrumEnabled: (command) => {
    spectrumEnabled = command.enabled
  },
  setDumpIq: () => {},
}

ctx.onmessage = (event: MessageEvent<ReceiverCommand>) => {
  const command = event.data
  const handler = handlers[command.type] as ((c: ReceiverCommand) => void) | undefined
  if (!handler) {
    postError(new Error(`unknown receiver command: ${(command as { type: string }).type}`))
    return
  }
  try {
    handler(command)
  } catch (error) {
    postError(error)
  }
}

post({ type: 'state', state: 'closed' })
