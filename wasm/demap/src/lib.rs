//! Channel estimation, equalization and carrier demapping for the ISDB-T
//! receiver. Mirrors `src/dsp/stages/channelEstimation.ts` and
//! `src/dsp/stages/carrierDemod.ts`.
//!
//! Intermediate arithmetic is done in f64 and stored back as f32, matching the
//! JavaScript number semantics of the reference implementation. The scattered
//! pilot reference for the center segment is supplied by the caller as one f32
//! per carrier (`pilotReferenceAt(k, mode)`), so this kernel only needs the
//! carriers-per-segment geometry.

use core::alloc::Layout;
use std::alloc::{alloc, dealloc};
use std::vec::Vec;

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

const DQPSK_PHASE_STEP: f64 = core::f64::consts::PI / 2.0;
const QAM16_NORM: f64 = 3.162_277_660_168_379_5; // sqrt(10)
const QAM64_NORM: f64 = 6.480_740_698_407_86; // sqrt(42)

fn scattered_pilot_indices(
    symbol_index_in_frame: usize,
    carriers_per_segment: usize,
) -> Vec<usize> {
    let mut out = Vec::new();
    let mut k = 3 * (symbol_index_in_frame % 4);
    while k < carriers_per_segment {
        out.push(k);
        k += 12;
    }
    out
}

fn estimate_into(
    bins_re: &[f32],
    bins_im: &[f32],
    seg_pilot_ref: &[f32],
    out_re: &mut [f32],
    out_im: &mut [f32],
    symbol_index_in_frame: usize,
    carriers_per_segment: usize,
) {
    let pilots = scattered_pilot_indices(symbol_index_in_frame, carriers_per_segment);

    for &k in &pilots {
        let inv = 1.0 / seg_pilot_ref[k] as f64;
        out_re[k] = (bins_re[k] as f64 * inv) as f32;
        out_im[k] = (bins_im[k] as f64 * inv) as f32;
    }

    if pilots.len() > 1 {
        for i in 0..pilots.len() - 1 {
            let a = pilots[i];
            let b = pilots[i + 1];
            let span = (b - a) as f64;
            let d_re = out_re[b] as f64 - out_re[a] as f64;
            let d_im = out_im[b] as f64 - out_im[a] as f64;
            for c in (a + 1)..b {
                let t = (c - a) as f64 / span;
                out_re[c] = (out_re[a] as f64 + d_re * t) as f32;
                out_im[c] = (out_im[a] as f64 + d_im * t) as f32;
            }
        }
    }

    let first = pilots[0];
    for c in 0..first {
        out_re[c] = out_re[first];
        out_im[c] = out_im[first];
    }
    let last = pilots[pilots.len() - 1];
    for c in (last + 1)..carriers_per_segment {
        out_re[c] = out_re[last];
        out_im[c] = out_im[last];
    }
}

/// LS channel estimate at scattered pilots with linear interpolation and edge
/// hold. `seg_pilot_ref` has one f32 per center-segment carrier.
#[no_mangle]
pub extern "C" fn demap_estimate_channel(
    bins_re: *const f32,
    bins_im: *const f32,
    seg_pilot_ref: *const f32,
    out_re: *mut f32,
    out_im: *mut f32,
    symbol_index_in_frame: usize,
    carriers_per_segment: usize,
) {
    if bins_re.is_null()
        || bins_im.is_null()
        || seg_pilot_ref.is_null()
        || out_re.is_null()
        || out_im.is_null()
        || carriers_per_segment == 0
    {
        return;
    }
    unsafe {
        let br = core::slice::from_raw_parts(bins_re, carriers_per_segment);
        let bi = core::slice::from_raw_parts(bins_im, carriers_per_segment);
        let sp = core::slice::from_raw_parts(seg_pilot_ref, carriers_per_segment);
        let or = core::slice::from_raw_parts_mut(out_re, carriers_per_segment);
        let oi = core::slice::from_raw_parts_mut(out_im, carriers_per_segment);
        estimate_into(
            br,
            bi,
            sp,
            or,
            oi,
            symbol_index_in_frame,
            carriers_per_segment,
        );
    }
}

/// One-pole temporal smoothing with a persistent previous estimate. Writes the
/// current (smoothed) estimate to `out_*` and copies it into `prev_*` for the
/// next call. `alpha` is the weight of the current estimate.
#[no_mangle]
pub extern "C" fn demap_estimator_estimate(
    bins_re: *const f32,
    bins_im: *const f32,
    seg_pilot_ref: *const f32,
    out_re: *mut f32,
    out_im: *mut f32,
    prev_re: *mut f32,
    prev_im: *mut f32,
    has_prev: u32,
    symbol_index_in_frame: usize,
    carriers_per_segment: usize,
    alpha: f64,
) {
    if bins_re.is_null()
        || bins_im.is_null()
        || seg_pilot_ref.is_null()
        || out_re.is_null()
        || out_im.is_null()
        || prev_re.is_null()
        || prev_im.is_null()
        || carriers_per_segment == 0
    {
        return;
    }
    unsafe {
        let br = core::slice::from_raw_parts(bins_re, carriers_per_segment);
        let bi = core::slice::from_raw_parts(bins_im, carriers_per_segment);
        let sp = core::slice::from_raw_parts(seg_pilot_ref, carriers_per_segment);
        let or = core::slice::from_raw_parts_mut(out_re, carriers_per_segment);
        let oi = core::slice::from_raw_parts_mut(out_im, carriers_per_segment);
        estimate_into(
            br,
            bi,
            sp,
            or,
            oi,
            symbol_index_in_frame,
            carriers_per_segment,
        );

        if has_prev != 0 {
            let a = alpha;
            let b = 1.0 - a;
            for i in 0..carriers_per_segment {
                or[i] = (a * or[i] as f64 + b * core::ptr::read(prev_re.add(i)) as f64) as f32;
                oi[i] = (a * oi[i] as f64 + b * core::ptr::read(prev_im.add(i)) as f64) as f32;
            }
        }

        core::ptr::copy_nonoverlapping(out_re, prev_re, carriers_per_segment);
        core::ptr::copy_nonoverlapping(out_im, prev_im, carriers_per_segment);
    }
}

/// Zero-forcing equalization: Z = Y * conj(H) / |H|^2.
#[no_mangle]
pub extern "C" fn demap_equalize(
    bins_re: *const f32,
    bins_im: *const f32,
    h_re: *const f32,
    h_im: *const f32,
    out_re: *mut f32,
    out_im: *mut f32,
    n: usize,
) {
    if bins_re.is_null()
        || bins_im.is_null()
        || h_re.is_null()
        || h_im.is_null()
        || out_re.is_null()
        || out_im.is_null()
        || n == 0
    {
        return;
    }
    unsafe {
        let br = core::slice::from_raw_parts(bins_re, n);
        let bi = core::slice::from_raw_parts(bins_im, n);
        let hr = core::slice::from_raw_parts(h_re, n);
        let hi = core::slice::from_raw_parts(h_im, n);
        let or = core::slice::from_raw_parts_mut(out_re, n);
        let oi = core::slice::from_raw_parts_mut(out_im, n);
        for i in 0..n {
            let hr = hr[i] as f64;
            let hi = hi[i] as f64;
            let d = hr * hr + hi * hi;
            let inv = if d > 1e-12 { 1.0 / d } else { 0.0 };
            or[i] = ((br[i] as f64 * hr + bi[i] as f64 * hi) * inv) as f32;
            oi[i] = ((bi[i] as f64 * hr - br[i] as f64 * hi) * inv) as f32;
        }
    }
}

fn dqpsk_slice(delta: f64) -> u8 {
    let two_pi = core::f64::consts::PI * 2.0;
    let wrapped = ((delta % two_pi) + two_pi) % two_pi;
    let index = ((wrapped + DQPSK_PHASE_STEP / 2.0) / DQPSK_PHASE_STEP).floor() as i64 % 4;
    (index ^ (index >> 1)) as u8
}

fn qpsk_slice(re: f64, im: f64) -> u8 {
    (((re < 0.0) as u8) << 1) | ((im < 0.0) as u8)
}

fn qam16_slice(re: f64, im: f64) -> u8 {
    let threshold = 2.0 / QAM16_NORM;
    (((re < 0.0) as u8) << 3)
        | (((im < 0.0) as u8) << 2)
        | (((re.abs() < threshold) as u8) << 1)
        | ((im.abs() < threshold) as u8)
}

fn qam64_slice(re: f64, im: f64) -> u8 {
    let threshold = 2.0 / QAM64_NORM;
    let ar = re.abs();
    let ai = im.abs();
    (((re < 0.0) as u8) << 5)
        | (((im < 0.0) as u8) << 4)
        | (((ar < 2.0 * threshold) as u8) << 3)
        | (((ai < 2.0 * threshold) as u8) << 2)
        | (((ar > threshold && ar < 3.0 * threshold) as u8) << 1)
        | ((ai > threshold && ai < 3.0 * threshold) as u8)
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn clamp_soft(value: f64) -> i8 {
    let v = js_round(value * 64.0);
    if v > 127.0 {
        127
    } else if v < -127.0 {
        -127
    } else {
        v as i8
    }
}

/// Hard demapping: one constellation label byte per carrier. `modulation` uses
/// the `CarrierModulation` codes (0 DQPSK, 1 QPSK, 2 QAM16, 3 QAM64).
#[no_mangle]
pub extern "C" fn demap_demodulate(
    modulation: u32,
    curr_re: *const f32,
    curr_im: *const f32,
    prev_re: *const f32,
    prev_im: *const f32,
    has_prev: u32,
    out: *mut u8,
    n: usize,
) {
    if curr_re.is_null() || curr_im.is_null() || out.is_null() || n == 0 {
        return;
    }
    if modulation == 0 && (prev_re.is_null() || prev_im.is_null() || has_prev == 0) {
        return;
    }
    unsafe {
        let cr = core::slice::from_raw_parts(curr_re, n);
        let ci = core::slice::from_raw_parts(curr_im, n);
        let o = core::slice::from_raw_parts_mut(out, n);
        match modulation {
            0 => {
                let pr = core::slice::from_raw_parts(prev_re, n);
                let pi = core::slice::from_raw_parts(prev_im, n);
                for k in 0..n {
                    let dr = ci[k] as f64 * pr[k] as f64 - cr[k] as f64 * pi[k] as f64;
                    let di = cr[k] as f64 * pr[k] as f64 + ci[k] as f64 * pi[k] as f64;
                    o[k] = dqpsk_slice(dr.atan2(di));
                }
            }
            1 => {
                for k in 0..n {
                    o[k] = qpsk_slice(cr[k] as f64, ci[k] as f64);
                }
            }
            2 => {
                for k in 0..n {
                    o[k] = qam16_slice(cr[k] as f64, ci[k] as f64);
                }
            }
            _ => {
                for k in 0..n {
                    o[k] = qam64_slice(cr[k] as f64, ci[k] as f64);
                }
            }
        }
    }
}

fn bits_per_carrier(modulation: u32) -> usize {
    match modulation {
        0 | 1 => 2,
        2 => 4,
        _ => 6,
    }
}

/// Soft demapping. QPSK/DQPSK produce `bitsPerCarrier` signed soft values per
/// carrier (positive means label bit 0); 16QAM/64QAM fall back to hard +/-127.
#[no_mangle]
pub extern "C" fn demap_demodulate_soft(
    modulation: u32,
    curr_re: *const f32,
    curr_im: *const f32,
    prev_re: *const f32,
    prev_im: *const f32,
    has_prev: u32,
    out: *mut i8,
    n: usize,
) {
    if curr_re.is_null() || curr_im.is_null() || out.is_null() || n == 0 {
        return;
    }
    if modulation == 0 && (prev_re.is_null() || prev_im.is_null() || has_prev == 0) {
        return;
    }
    unsafe {
        let cr = core::slice::from_raw_parts(curr_re, n);
        let ci = core::slice::from_raw_parts(curr_im, n);
        let bits = bits_per_carrier(modulation);
        let o = core::slice::from_raw_parts_mut(out, n * bits);
        if modulation == 1 {
            for k in 0..n {
                o[2 * k] = clamp_soft(cr[k] as f64);
                o[2 * k + 1] = clamp_soft(ci[k] as f64);
            }
            return;
        }
        if modulation == 0 {
            let pr = core::slice::from_raw_parts(prev_re, n);
            let pi = core::slice::from_raw_parts(prev_im, n);
            for k in 0..n {
                let dr = cr[k] as f64 * pr[k] as f64 + ci[k] as f64 * pi[k] as f64;
                let di = ci[k] as f64 * pr[k] as f64 - cr[k] as f64 * pi[k] as f64;
                o[2 * k] = clamp_soft(dr);
                o[2 * k + 1] = clamp_soft(-di);
            }
            return;
        }
        let mut hard = Vec::with_capacity(n);
        for k in 0..n {
            hard.push(match modulation {
                2 => qam16_slice(cr[k] as f64, ci[k] as f64),
                _ => qam64_slice(cr[k] as f64, ci[k] as f64),
            });
        }
        let mut oi = 0usize;
        for i in 0..n {
            let b = hard[i];
            for j in (0..bits).rev() {
                o[oi] = if ((b >> j) & 1) == 0 { 127 } else { -127 };
                oi += 1;
            }
        }
    }
}

/// Fused per-symbol demap.
///
/// Extracts the center-segment carriers from a one-seg FFT output, forms the LS
/// channel estimate (with optional one-pole temporal smoothing), zero-forcing
/// equalizes only the requested data carriers and writes them compactly to
/// `out_*`. Equivalent to `demap_estimator_estimate` followed by
/// `demap_equalize` restricted to `data_idx`.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn demap_process_symbol(
    fft_re: *const f32,
    fft_im: *const f32,
    fft_size: usize,
    carrier_base: i32,
    bins_re: *mut f32,
    bins_im: *mut f32,
    seg_pilot_ref: *const f32,
    h_re: *mut f32,
    h_im: *mut f32,
    prev_re: *mut f32,
    prev_im: *mut f32,
    has_prev: u32,
    symbol_index_in_frame: usize,
    carriers_per_segment: usize,
    alpha: f64,
    data_idx: *const u32,
    data_count: usize,
    out_re: *mut f32,
    out_im: *mut f32,
) {
    if fft_re.is_null()
        || fft_im.is_null()
        || bins_re.is_null()
        || bins_im.is_null()
        || seg_pilot_ref.is_null()
        || h_re.is_null()
        || h_im.is_null()
        || prev_re.is_null()
        || prev_im.is_null()
        || out_re.is_null()
        || out_im.is_null()
        || fft_size == 0
        || carriers_per_segment == 0
        || data_count == 0
        || data_idx.is_null()
    {
        return;
    }
    unsafe {
        let fr = core::slice::from_raw_parts(fft_re, fft_size);
        let fi = core::slice::from_raw_parts(fft_im, fft_size);
        let br = core::slice::from_raw_parts_mut(bins_re, carriers_per_segment);
        let bi = core::slice::from_raw_parts_mut(bins_im, carriers_per_segment);
        let n = fft_size as i64;
        let base = carrier_base as i64;
        for c in 0..carriers_per_segment {
            let bin = ((base + c as i64) % n + n) % n;
            br[c] = fr[bin as usize];
            bi[c] = fi[bin as usize];
        }

        let sp = core::slice::from_raw_parts(seg_pilot_ref, carriers_per_segment);
        let hr = core::slice::from_raw_parts_mut(h_re, carriers_per_segment);
        let hi = core::slice::from_raw_parts_mut(h_im, carriers_per_segment);
        estimate_into(
            br,
            bi,
            sp,
            hr,
            hi,
            symbol_index_in_frame,
            carriers_per_segment,
        );

        let pr = core::slice::from_raw_parts_mut(prev_re, carriers_per_segment);
        let pi = core::slice::from_raw_parts_mut(prev_im, carriers_per_segment);
        if has_prev != 0 {
            let a = alpha;
            let b = 1.0 - a;
            for i in 0..carriers_per_segment {
                hr[i] = (a * hr[i] as f64 + b * pr[i] as f64) as f32;
                hi[i] = (a * hi[i] as f64 + b * pi[i] as f64) as f32;
            }
        }
        core::ptr::copy_nonoverlapping(hr.as_ptr(), pr.as_mut_ptr(), carriers_per_segment);
        core::ptr::copy_nonoverlapping(hi.as_ptr(), pi.as_mut_ptr(), carriers_per_segment);

        let idx = core::slice::from_raw_parts(data_idx, data_count);
        let ore = core::slice::from_raw_parts_mut(out_re, data_count);
        let oim = core::slice::from_raw_parts_mut(out_im, data_count);
        for k in 0..data_count {
            let d = idx[k] as usize;
            let hre = hr[d] as f64;
            let him = hi[d] as f64;
            let den = hre * hre + him * him;
            let inv = if den > 1e-12 { 1.0 / den } else { 0.0 };
            ore[k] = ((br[d] as f64 * hre + bi[d] as f64 * him) * inv) as f32;
            oim[k] = ((bi[d] as f64 * hre - br[d] as f64 * him) * inv) as f32;
        }
    }
}
