/** Media stream DTOs produced by the TS demuxer (要件定義書 28). */
import type { StreamKind } from './transportStream'

export interface PesPacket {
  pid: number
  kind: StreamKind
  /** PES stream_id. */
  streamId: number
  /** Presentation timestamp in 90 kHz units, if present. */
  pts?: number
  /** Decode timestamp in 90 kHz units, if present. */
  dts?: number
  /** Elementary stream payload (PES payload, header stripped). */
  data: Uint8Array
}

/** AVC decoder configuration extracted from an AVC video descriptor. */
export interface AvcConfig {
  configurationVersion: number
  avcProfileIndication: number
  profileCompatibility: number
  avcLevelIndication: number
  /** Raw AVCDecoderConfigurationRecord bytes for VideoDecoder. */
  description: Uint8Array
}

export interface AudioStreamInfo {
  /** ISO_639 language code, if signalled. */
  language?: string
  /** Audio stream type (0x0f = AAC). */
  streamType: number
  /** True when the stream is HE-AAC (SBR) signalled by ARIB. */
  aacProfile?: number
  sampleRate?: number
  channelCount?: number
}
