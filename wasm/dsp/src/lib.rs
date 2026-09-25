//! Single merged ISDB-T DSP module.
//!
//! All receive-chain kernels (FFT, OFDM sync, resampling/NCO, channel
//! estimation/demapping, deinterleaving, Viterbi, Reed-Solomon) live in one
//! `wasm32-unknown-unknown` cdylib so they share a linear memory and a single
//! Rust allocator. The module also exposes the fused one-seg FEC decoder in
//! `oneseg`, which keeps an entire symbol batch inside WASM and returns MPEG-TS
//! bytes directly, removing the per-stage host round-trips.

mod deinterleave;
mod demap;
mod fft;
mod ofdm;
mod oneseg;
mod reed_solomon;
mod resample;
mod viterbi;

use core::alloc::Layout;
use std::alloc::{alloc, dealloc};

#[no_mangle]
pub extern "C" fn dsp_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return core::ptr::null_mut();
    }
    unsafe { alloc(Layout::from_size_align_unchecked(size, 8)) }
}

#[no_mangle]
pub extern "C" fn dsp_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    unsafe { dealloc(ptr, Layout::from_size_align_unchecked(size, 8)) }
}
