/** TMCC (Transmission and Multiplexing Configuration Control) decoded info. */
export interface TmccLayerInfo {
  /** CarrierModulation code (0=DQPSK,1=QPSK,2=16QAM,3=64QAM). */
  modulation: number
  /** CodeRate code (0=1/2,1=2/3,2=3/4,3=5/6,4=7/8). */
  codeRate: number
  /** Time interleaving code. */
  timeInterleave: number
  /** Number of segments in the layer. */
  segments: number
}

export interface TmccInfo {
  /** True once frame sync and parity have been validated. */
  locked: boolean
  /** Transmission mode (1/2/3), if decoded. */
  mode: number | null
  /** Guard interval ratio (4/8/16/32). */
  guardIntervalRatio: number | null
  /** Partial reception (one-seg) flag. */
  partialReception: boolean
  /** System descriptor (B20-B21). */
  systemDescriptor: number | null
  layers: {
    A: TmccLayerInfo | null
    B: TmccLayerInfo | null
    C: TmccLayerInfo | null
  }
  /** Frame counter since lock, for diagnostics. */
  frameCount: number
  /** Raw 204 bits as bytes (0/1) for the debug dump. */
  rawBits?: Uint8Array
}
