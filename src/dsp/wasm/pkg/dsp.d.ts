/* tslint:disable */
/* eslint-disable */

export function initThreadPool(num_threads: number): Promise<any>;

export class wbg_rayon_PoolBuilder {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    build(): void;
    numThreads(): number;
    receiver(): number;
}

export function wbg_rayon_start_worker(receiver: number): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly byte_deinterleaver_create: () => number;
    readonly byte_deinterleaver_destroy: (a: number) => void;
    readonly byte_deinterleaver_process: (a: number, b: number, c: number, d: number) => void;
    readonly byte_deinterleaver_process_byte: (a: number, b: number) => number;
    readonly byte_deinterleaver_reset: (a: number) => void;
    readonly dc_create: (a: number) => number;
    readonly dc_destroy: (a: number) => void;
    readonly dc_process: (a: number, b: number, c: number, d: number) => void;
    readonly dc_reset: (a: number) => void;
    readonly demap_demodulate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly demap_demodulate_soft: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly demap_equalize: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly demap_estimate_channel: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
    readonly demap_estimator_estimate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number) => void;
    readonly demap_process_symbol: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number) => void;
    readonly dsp_alloc: (a: number) => number;
    readonly dsp_free: (a: number, b: number) => void;
    readonly fft_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly fft_forward: (a: number, b: number, c: number) => void;
    readonly fft_inverse: (a: number, b: number, c: number) => void;
    readonly frequency_deinterleave: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly frequency_interleave: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly frequency_time_deinterleave: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => void;
    readonly time_deinterleaver_process: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly frontend_clear_pending: (a: number) => void;
    readonly frontend_create: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number) => number;
    readonly ofdm_sync_create: (a: number, b: number, c: number, d: number) => number;
    readonly frontend_destroy: (a: number) => void;
    readonly frontend_pending_count: (a: number) => number;
    readonly frontend_pending_im: (a: number) => number;
    readonly frontend_pending_re: (a: number) => number;
    readonly frontend_push: (a: number, b: number, c: number, d: number) => number;
    readonly ofdm_sync_process: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly frontend_reset: (a: number) => void;
    readonly frontend_tmcc_version: (a: number) => number;
    readonly frontend_write_stats: (a: number, b: number) => void;
    readonly frontend_write_tmcc: (a: number, b: number) => void;
    readonly frontend_write_tmcc_bits: (a: number, b: number) => void;
    readonly nco_create: (a: number, b: number) => number;
    readonly nco_process: (a: number, b: number, c: number, d: number) => void;
    readonly nco_reset: (a: number) => void;
    readonly nco_set_offset: (a: number, b: number) => void;
    readonly ofdm_freq_estimate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly ofdm_sync_destroy: (a: number) => void;
    readonly ofdm_sync_reset: (a: number) => void;
    readonly ofdm_sync_starts_ptr: (a: number) => number;
    readonly oneseg_decoder_create: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number) => number;
    readonly time_deinterleaver_create: (a: number, b: number) => number;
    readonly soft_bit_deinterleaver_create: (a: number, b: number) => number;
    readonly oneseg_decoder_decode_batch: (a: number, b: number, c: number, d: number) => number;
    readonly soft_bit_deinterleaver_process: (a: number, b: number, c: number, d: number) => void;
    readonly rs_decode: (a: number, b: number) => number;
    readonly oneseg_decoder_destroy: (a: number) => void;
    readonly time_deinterleaver_destroy: (a: number) => void;
    readonly oneseg_decoder_packets: (a: number) => number;
    readonly oneseg_decoder_reset: (a: number) => void;
    readonly time_deinterleaver_reset: (a: number) => void;
    readonly oneseg_decoder_sync_errors: (a: number) => number;
    readonly oneseg_decoder_ts_ptr: (a: number) => number;
    readonly resample_create: (a: number, b: number, c: number) => number;
    readonly resample_destroy: (a: number) => void;
    readonly resample_out_im: (a: number) => number;
    readonly resample_out_re: (a: number) => number;
    readonly resample_process: (a: number, b: number, c: number, d: number) => number;
    readonly resample_reset: (a: number) => void;
    readonly soft_bit_deinterleaver_destroy: (a: number) => void;
    readonly soft_bit_deinterleaver_reset: (a: number) => void;
    readonly tmcc_decoder_create: (a: number, b: number) => number;
    readonly tmcc_decoder_destroy: (a: number) => void;
    readonly tmcc_decoder_frame_start_symbol: (a: number) => number;
    readonly tmcc_decoder_push: (a: number, b: number, c: number) => number;
    readonly tmcc_decoder_reset: (a: number) => void;
    readonly tmcc_decoder_write_bits: (a: number, b: number) => void;
    readonly viterbi_decode: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly viterbi_decode_soft: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly viterbi_stream_create: (a: number) => number;
    readonly viterbi_stream_destroy: (a: number) => void;
    readonly viterbi_stream_feed_soft: (a: number, b: number) => number;
    readonly viterbi_stream_feed_soft_block: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly viterbi_stream_reset: (a: number) => void;
    readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
    readonly initThreadPool: (a: number) => any;
    readonly wbg_rayon_poolbuilder_build: (a: number) => void;
    readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
    readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
    readonly wbg_rayon_start_worker: (a: number) => void;
    readonly nco_destroy: (a: number) => void;
    readonly tmcc_decoder_write_info: (a: number, b: number) => void;
    readonly memory: WebAssembly.Memory;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
    readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
 * @param {WebAssembly.Memory} memory - Deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
