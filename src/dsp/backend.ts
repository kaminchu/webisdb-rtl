/**
 * DSP backend swap boundary (要件定義書 14).
 *
 * TypeScript implementations live alongside WASM implementations behind these
 * interfaces so hot paths can be moved to WASM later without changing callers.
 */

export interface FftBackend {
  readonly name: string
  /** In-place or out-of-place forward FFT. Input/output are complex interleaved. */
  forward(re: Float32Array, im: Float32Array): void
  inverse(re: Float32Array, im: Float32Array): void
}

export interface ViterbiBackend {
  readonly name: string
  /**
   * Decode a depunctured soft/hard bit stream.
   * @param input bits: 0/1 hard, or erasure = 2 for depunctured positions.
   * @param rate puncturing rate index; see isdbtParams.
   * @param terminate whether the encoder was terminated with tail bits.
   */
  decode(input: Uint8Array, rate: ViterbiRate, terminate: boolean): Uint8Array
  /**
   * Optional soft-decision decode. `input` holds signed soft values (positive
   * means bit 0, 0 means erasure), most significant bit first.
   */
  decodeSoft?(input: Int8Array, rate: ViterbiRate, terminate: boolean): Uint8Array
}

export type ViterbiRate = '1/2' | '2/3' | '3/4' | '5/6' | '7/8'

export interface RsBackend {
  readonly name: string
  /**
   * Decode a Reed-Solomon RS(204,188) codeword.
   * @param block 204 bytes (shortened RS(255,239)).
   * @returns decoded 188 bytes, or null when uncorrectable.
   */
  decode(block: Uint8Array): Uint8Array | null
}

export interface DspBackends {
  fft: FftBackend
  viterbi: ViterbiBackend
  rs: RsBackend
}
