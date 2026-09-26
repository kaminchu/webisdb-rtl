/**
 * Reception quality / processing metrics (要件定義書 30, 31).
 */

export interface ReceptionQuality {
  /** Estimated signal power in dB (relative). */
  signalLevelDb: number | null
  /** Carrier to noise ratio in dB. */
  cnDb: number | null
  /** Modulation error ratio in dB. */
  merDb: number | null
  /** Bit error rate measured after Viterbi (before RS). */
  ber: number | null
  /** TS packet error count since reset. */
  packetErrors: number
  /** Estimated carrier frequency offset in Hz. */
  frequencyOffsetHz: number | null
}

/** Active input-rate conversion used by the locked front end. */
export type FrontendPath = 'u8-decimator' | 'fractional-resampler'

/**
 * Cumulative DSP cost split by pipeline stage, expressed in milliseconds per
 * second of input signal. All values share the same denominator, so they can be
 * compared directly against each other and summed.
 */
export interface StageTimings {
  /** U8 unpack, DC removal and rate conversion. */
  preprocessMsPerSecond: number
  /** NCO, timing synchronisation, FFT, channel estimation and equalisation. */
  frontendMsPerSecond: number
  /** FEC: deinterleave, Viterbi, Reed-Solomon and TS assembly. */
  decoderMsPerSecond: number
  /** Acquisition scan (a subset of preprocess + frontend while unlocked). */
  acquisitionMsPerSecond: number
  /** GPU batch latency including readback (WebGPU front end only). */
  gpuBatchMsPerSecond: number
  /** GPU readback (`mapAsync`) wait (WebGPU front end only). */
  gpuReadbackMsPerSecond: number
}

export interface ThroughputMetrics {
  /** USB transfer throughput in bytes/sec. */
  usbBytesPerSecond: number
  /** IQ samples consumed per second by DSP. */
  iqSamplesPerSecond: number
  /** TS bytes produced per second. */
  tsBytesPerSecond: number
  /** DSP wall-clock utilization (processing time / wall time), 0..1+. */
  dspUtilization: number
  /** Average DSP processing time per second of input signal, in ms. */
  dspProcessingMsPerSecond: number
  /**
   * DSP seconds spent per input-signal second (dspProcessingMsPerSecond / 1000).
   * Below 1 means real-time processing with headroom; at or above 1 the receiver
   * cannot keep up even though wall utilization may saturate near 100%.
   */
  realTimeFactor: number
  /** Which rate-conversion path the pipeline selected. */
  frontendPath: FrontendPath
  /** Per-stage DSP cost, measured on the receiver worker. */
  stages: StageTimings
  /** Acquisition scans started since the session began. */
  acquisitionCount: number
  /** Times a locked front end was released back to acquisition. */
  lockLossCount: number
}

export interface BufferMetrics {
  /** Buffered IQ samples not yet processed. */
  bufferedSamples: number
  /** Buffered IQ bytes. */
  bufferedBytes: number
  /** Buffer occupancy 0..1. */
  occupancy: number
  /** Estimated playback delay caused by buffered data, in seconds. */
  estimatedDelaySeconds: number
  /** Samples dropped due to overflow. */
  droppedSamples: number
  /** Input throughput in samples/sec. */
  inputSamplesPerSecond: number
  /** DSP throughput in samples/sec. */
  dspSamplesPerSecond: number
}

export interface ReceiverStats {
  quality: ReceptionQuality
  throughput: ThroughputMetrics
  buffer: BufferMetrics
  /** Uptime of the current session in seconds. */
  uptimeSeconds: number
}

export const emptyReceptionQuality: ReceptionQuality = {
  signalLevelDb: null,
  cnDb: null,
  merDb: null,
  ber: null,
  packetErrors: 0,
  frequencyOffsetHz: null,
}

export const emptyStageTimings: StageTimings = {
  preprocessMsPerSecond: 0,
  frontendMsPerSecond: 0,
  decoderMsPerSecond: 0,
  acquisitionMsPerSecond: 0,
  gpuBatchMsPerSecond: 0,
  gpuReadbackMsPerSecond: 0,
}

export const emptyThroughput: ThroughputMetrics = {
  usbBytesPerSecond: 0,
  iqSamplesPerSecond: 0,
  tsBytesPerSecond: 0,
  dspUtilization: 0,
  dspProcessingMsPerSecond: 0,
  realTimeFactor: 0,
  frontendPath: 'fractional-resampler',
  stages: { ...emptyStageTimings },
  acquisitionCount: 0,
  lockLossCount: 0,
}

export const emptyBufferMetrics: BufferMetrics = {
  bufferedSamples: 0,
  bufferedBytes: 0,
  occupancy: 0,
  estimatedDelaySeconds: 0,
  droppedSamples: 0,
  inputSamplesPerSecond: 0,
  dspSamplesPerSecond: 0,
}
