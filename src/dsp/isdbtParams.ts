/**
 * ISDB-T transmission parameters (ARIB STD-B31).
 *
 * References the 6 MHz Japanese terrestrial channel. One-seg uses the center
 * segment (segment 0) of the 13-segment OFDM signal.
 */

/** Full-band IFFT sampling frequency for a 6 MHz channel: 512/63 MHz. */
export const FFT_SAMPLING_HZ = (512 / 63) * 1_000_000

/**
 * One-seg (partial reception) sampling frequency: FFT_SAMPLING_HZ / 8 = 64/63 MHz.
 * The one-seg FFT size is the full FFT size / 8.
 */
export const ONESEG_SAMPLING_HZ = FFT_SAMPLING_HZ / 8

/** Number of segments in an ISDB-T channel. */
export const NUM_SEGMENTS = 13

/** Segment used for partial (one-seg) reception. */
export const ONESEG_SEGMENT = 0

/** Number of OFDM symbols per frame (common to all modes). */
export const SYMBOLS_PER_FRAME = 204

/** Physical order of logical segments, low frequency to high frequency. */
export const SEGMENT_PHYSICAL_ORDER = [11, 9, 7, 5, 3, 1, 0, 2, 4, 6, 8, 10, 12] as const

export const TransmissionMode = {
  Mode1: 1,
  Mode2: 2,
  Mode3: 3,
} as const

export type TransmissionMode = (typeof TransmissionMode)[keyof typeof TransmissionMode]

export interface ModeParams {
  mode: TransmissionMode
  /** Full-band FFT size. */
  fftSize: number
  /** One-seg FFT size (fftSize / 8). */
  oneSegFftSize: number
  /** Carriers per segment. */
  carriersPerSegment: number
  /** Data carriers per segment. */
  dataCarriersPerSegment: number
  /** Scattered pilot carriers per segment. */
  spPerSegment: number
  /** TMCC carriers per segment. */
  tmccPerSegment: number
  /** Auxiliary channel carriers per segment. */
  acPerSegment: number
  /** Total active carriers across the full band (13 segments + 1 continual pilot). */
  activeCarriers: number
  /** Useful symbol duration in microseconds. */
  usefulSymbolUs: number
  /** Carrier spacing in Hz. */
  carrierSpacingHz: number
}

export const MODE_PARAMS: Record<TransmissionMode, ModeParams> = {
  1: {
    mode: 1,
    fftSize: 2048,
    oneSegFftSize: 256,
    carriersPerSegment: 108,
    dataCarriersPerSegment: 96,
    spPerSegment: 9,
    tmccPerSegment: 1,
    acPerSegment: 2,
    activeCarriers: 1405,
    usefulSymbolUs: 252,
    carrierSpacingHz: FFT_SAMPLING_HZ / 2048,
  },
  2: {
    mode: 2,
    fftSize: 4096,
    oneSegFftSize: 512,
    carriersPerSegment: 216,
    dataCarriersPerSegment: 192,
    spPerSegment: 18,
    tmccPerSegment: 2,
    acPerSegment: 4,
    activeCarriers: 2809,
    usefulSymbolUs: 504,
    carrierSpacingHz: FFT_SAMPLING_HZ / 4096,
  },
  3: {
    mode: 3,
    fftSize: 8192,
    oneSegFftSize: 1024,
    carriersPerSegment: 432,
    dataCarriersPerSegment: 384,
    spPerSegment: 36,
    tmccPerSegment: 4,
    acPerSegment: 8,
    activeCarriers: 5617,
    usefulSymbolUs: 1008,
    carrierSpacingHz: FFT_SAMPLING_HZ / 8192,
  },
}

export const GuardIntervalRatio = {
  GI_1_4: 4,
  GI_1_8: 8,
  GI_1_16: 16,
  GI_1_32: 32,
} as const

export type GuardIntervalRatio = (typeof GuardIntervalRatio)[keyof typeof GuardIntervalRatio]

/**
 * TMCC carrier positions in the full-band active-carrier index space for Mode 3 (52 carriers).
 * Mode 1 uses the first 13 entries, Mode 2 the first 26.
 */
export const TMCC_CARRIERS_MODE3: readonly number[] = [
  70, 133, 233, 410, 476, 587, 697, 787, 947, 1033, 1165, 1289, 1319, 1474, 1537, 1637, 1814, 1880,
  1991, 2101, 2191, 2351, 2437, 2569, 2693, 2723, 2878, 2941, 3041, 3218, 3284, 3395, 3505, 3595,
  3755, 3841, 3973, 4097, 4127, 4282, 4345, 4445, 4622, 4688, 4799, 4909, 4999, 5159, 5245, 5377,
  5501, 5531,
]

/** TMCC carrier positions for a given mode. */
export function tmccCarriers(mode: TransmissionMode): readonly number[] {
  const count = MODE_PARAMS[mode].tmccPerSegment * NUM_SEGMENTS
  return TMCC_CARRIERS_MODE3.slice(0, count)
}

/** Integer offset of the center (one-seg) segment within the active-carrier space. */
export function centerSegmentCarrierOffset(mode: TransmissionMode): number {
  const physicalPosition = SEGMENT_PHYSICAL_ORDER.indexOf(ONESEG_SEGMENT)
  return physicalPosition * MODE_PARAMS[mode].carriersPerSegment
}

/**
 * TMCC carrier positions relative to the start of the center segment (Mode 3: 4 carriers).
 */
export function oneSegTmccCarriers(mode: TransmissionMode): number[] {
  const off = centerSegmentCarrierOffset(mode)
  const n = MODE_PARAMS[mode].tmccPerSegment
  return tmccCarriers(mode)
    .filter((c) => c >= off && c < off + MODE_PARAMS[mode].carriersPerSegment)
    .slice(0, n)
    .map((c) => c - off)
}

/** Scattered pilot carrier index within a segment for a given OFDM symbol index. */
export function scatteredPilotIndices(
  symbolIndexInFrame: number,
  carriersPerSegment: number,
): number[] {
  const out: number[] = []
  for (let k = 3 * (symbolIndexInFrame % 4); k < carriersPerSegment; k += 12) {
    out.push(k)
  }
  return out
}

/** Amplitude of scattered/continual/TMCC pilots relative to unit-RMS data. */
export const PILOT_BOOST = 4 / 3

/**
 * Generate the pilot reference sequence (ARIB STD-B31 11-bit LFSR, x^11 + x^9 + 1,
 * initial state all ones). Returns +/- PILOT_BOOST per active carrier.
 */
export function pilotReference(activeCarriers: number): Float32Array {
  const out = new Float32Array(activeCarriers)
  let reg = (1 << 11) - 1
  for (let k = 0; k < activeCarriers; k++) {
    const aux = reg & 1
    const newBit = ((reg >> 2) ^ reg) & 1
    reg = (reg >> 1) | (newBit << 10)
    const shift = 2 * (0.5 - aux)
    out[k] = (4 * shift) / 3
  }
  return out
}

/** Layer modulation, as signalled in TMCC. */
export const CarrierModulation = {
  DQPSK: 0,
  QPSK: 1,
  QAM16: 2,
  QAM64: 3,
} as const

export type CarrierModulation = (typeof CarrierModulation)[keyof typeof CarrierModulation]

/** Convolutional coding rate, as signalled in TMCC. */
export const CodeRate = {
  R1_2: 0,
  R2_3: 1,
  R3_4: 2,
  R5_6: 3,
  R7_8: 4,
} as const

export type CodeRate = (typeof CodeRate)[keyof typeof CodeRate]

/** Map a TMCC code-rate code to a backend rate string. */
export function codeRateName(code: number): '1/2' | '2/3' | '3/4' | '5/6' | '7/8' {
  switch (code) {
    case CodeRate.R2_3:
      return '2/3'
    case CodeRate.R3_4:
      return '3/4'
    case CodeRate.R5_6:
      return '5/6'
    case CodeRate.R7_8:
      return '7/8'
    default:
      return '1/2'
  }
}

/** Time-interleaving length code (TMCC) to actual symbol length. */
export function timeInterleaveLength(code: number, mode: TransmissionMode): number {
  const base = mode === 3 ? 1 : mode === 2 ? 2 : 4
  switch (code & 0b11) {
    case 0:
      return 0
    case 1:
      return base
    case 2:
      return base * 2
    default:
      return base * 4
  }
}
