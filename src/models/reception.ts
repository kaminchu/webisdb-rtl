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

export interface ThroughputMetrics {
  /** USB transfer throughput in bytes/sec. */
  usbBytesPerSecond: number
  /** IQ samples consumed per second by DSP. */
  iqSamplesPerSecond: number
  /** TS bytes produced per second. */
  tsBytesPerSecond: number
  /** DSP wall-clock utilization (processing time / wall time), 0..1+. */
  dspUtilization: number
  /** Average DSP processing time per second of input, in ms. */
  dspProcessingMsPerSecond: number
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

export const emptyThroughput: ThroughputMetrics = {
  usbBytesPerSecond: 0,
  iqSamplesPerSecond: 0,
  tsBytesPerSecond: 0,
  dspUtilization: 0,
  dspProcessingMsPerSecond: 0,
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
