//! OFDM symbol synchronization and carrier frequency offset kernel for the
//! ISDB-T receiver.
//!
//! Mirrors `src/dsp/stages/ofdmSync.ts` (`OfdmSynchronizer`) and
//! `src/dsp/stages/frequencyCorrection.ts` (`FrequencyOffsetEstimator`).
//! Correlations, metrics and phases are accumulated/evaluated in f64 to match
//! the JavaScript number semantics of the reference while the sample buffer
//! stays f32.

use core::alloc::Layout;
use core::f64::consts::PI;
use std::alloc::{alloc, dealloc};

const RHO: f64 = 0.5;
const TIMING_SEARCH: i64 = 8;

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

struct Peak {
    index: i64,
    metric: f64,
    gamma_re: f64,
    gamma_im: f64,
    phi: f64,
}

pub struct SyncState {
    fft_size: usize,
    cp_length: usize,
    symbol_length: usize,
    sample_rate_hz: f64,
    tracking: bool,
    buf_re: Vec<f32>,
    buf_im: Vec<f32>,
    buf_len: usize,
    base_index: f64,
    next_start: f64,
    synced: bool,
    last_offset: Option<f64>,
    last_metric: f64,
    last_gamma_mag: f64,
    last_phi: f64,
    starts: Vec<f64>,
}

impl SyncState {
    fn new(fft_size: usize, gi_ratio: usize, sample_rate_hz: f64, tracking: bool) -> Self {
        let cp_length = fft_size / gi_ratio;
        let symbol_length = fft_size + cp_length;
        let cap = 4 * symbol_length + fft_size;
        Self {
            fft_size,
            cp_length,
            symbol_length,
            sample_rate_hz,
            tracking,
            buf_re: Vec::with_capacity(cap),
            buf_im: Vec::with_capacity(cap),
            buf_len: 0,
            base_index: 0.0,
            next_start: -1.0,
            synced: false,
            last_offset: None,
            last_metric: 0.0,
            last_gamma_mag: 0.0,
            last_phi: 0.0,
            starts: Vec::new(),
        }
    }

    fn reset(&mut self) {
        self.buf_re.clear();
        self.buf_im.clear();
        self.buf_len = 0;
        self.base_index = 0.0;
        self.next_start = -1.0;
        self.synced = false;
        self.last_offset = None;
        self.last_metric = 0.0;
        self.last_gamma_mag = 0.0;
        self.last_phi = 0.0;
        self.starts.clear();
    }

    fn append(&mut self, re: &[f32], im: &[f32]) {
        let len = re.len().min(im.len());
        self.buf_re.extend_from_slice(&re[..len]);
        self.buf_im.extend_from_slice(&im[..len]);
        self.buf_len += len;
    }

    fn discard_front(&mut self, count: usize) {
        if count == 0 || count > self.buf_len {
            return;
        }
        self.buf_re.copy_within(count..self.buf_len, 0);
        self.buf_im.copy_within(count..self.buf_len, 0);
        self.buf_len -= count;
        self.buf_re.truncate(self.buf_len);
        self.buf_im.truncate(self.buf_len);
        self.base_index += count as f64;
    }

    fn find_peak(&self, from: i64, to: i64) -> Option<Peak> {
        let n = self.fft_size;
        let l = self.cp_length;
        let max_start = self.buf_len as i64 - (n + l) as i64;
        let hi = to.min(max_start);
        if from > hi {
            return None;
        }
        let mut best: Option<Peak> = None;
        let mut start = from;
        while start <= hi {
            let mut gamma_re = 0.0f64;
            let mut gamma_im = 0.0f64;
            let mut phi = 0.0f64;
            let s = start as usize;
            for i in 0..l {
                let a = s + i;
                let b = a + n;
                let ar = self.buf_re[a] as f64;
                let ai = self.buf_im[a] as f64;
                let br = self.buf_re[b] as f64;
                let bi = self.buf_im[b] as f64;
                gamma_re += ar * br + ai * bi;
                gamma_im += ai * br - ar * bi;
                phi += 0.5 * (ar * ar + ai * ai);
                phi += 0.5 * (br * br + bi * bi);
            }
            let metric = gamma_re.hypot(gamma_im) - RHO * phi;
            let better = match &best {
                None => true,
                Some(p) => metric > p.metric,
            };
            if better {
                best = Some(Peak {
                    index: start,
                    metric,
                    gamma_re,
                    gamma_im,
                    phi,
                });
            }
            start += 1;
        }
        best
    }

    fn track_offset(&mut self, peak: &Peak) {
        let phase = peak.gamma_im.atan2(peak.gamma_re);
        self.last_offset = Some(-phase * self.sample_rate_hz / (2.0 * PI * self.fft_size as f64));
        self.last_metric = peak.metric;
        self.last_gamma_mag = peak.gamma_re.hypot(peak.gamma_im);
        self.last_phi = peak.phi;
    }

    fn process(&mut self, re: &[f32], im: &[f32]) -> usize {
        self.append(re, im);
        self.starts.clear();
        let end = self.base_index + self.buf_len as f64;

        if !self.synced {
            let max_start = self.buf_len as i64 - (self.fft_size + self.cp_length) as i64;
            if max_start >= 0 {
                let search_to = max_start.min(3 * self.symbol_length as i64);
                let peak = self.find_peak(0, search_to);
                let acquired = match &peak {
                    Some(p) => p.metric > 0.0,
                    None => false,
                };
                if acquired {
                    let p = peak.unwrap();
                    self.synced = true;
                    self.next_start = self.base_index + p.index as f64;
                    self.track_offset(&p);
                } else {
                    let keep = self.symbol_length + self.cp_length;
                    if self.buf_len > keep {
                        self.discard_front(self.buf_len - keep);
                    }
                }
            }
        }

        if self.synced {
            while self.next_start + self.symbol_length as f64 <= end {
                let rel = (self.next_start - self.base_index) as i64;
                let radius = if self.tracking { TIMING_SEARCH } else { 0 };
                if rel - radius >= 0
                    && rel + (self.fft_size + self.cp_length) as i64 + radius <= self.buf_len as i64
                {
                    if let Some(p) = self.find_peak(rel - radius, rel + radius) {
                        self.track_offset(&p);
                        if self.tracking {
                            self.next_start = self.base_index + p.index as f64;
                        }
                    }
                }
                self.starts.push(self.next_start + self.cp_length as f64);
                self.next_start += self.symbol_length as f64;
            }
            let keep_from = (self.next_start - self.base_index - self.cp_length as f64).max(0.0);
            if keep_from > 0.0 {
                self.discard_front(keep_from as usize);
            }
        }

        self.starts.len()
    }
}

#[no_mangle]
pub extern "C" fn ofdm_sync_create(
    fft_size: usize,
    gi_ratio: usize,
    sample_rate_hz: f64,
    tracking: u32,
) -> *mut SyncState {
    Box::into_raw(Box::new(SyncState::new(
        fft_size,
        gi_ratio,
        sample_rate_hz,
        tracking != 0,
    )))
}

#[no_mangle]
pub extern "C" fn ofdm_sync_reset(state: *mut SyncState) {
    if let Some(s) = unsafe { state.as_mut() } {
        s.reset();
    }
}

/// Append `len` samples and run acquisition/tracking. Writes the result scalars
/// to `out` as `[metric, gamma_magnitude, phi, fractional_offset, has_offset]`
/// and returns the number of symbol starts stored internally.
#[no_mangle]
pub extern "C" fn ofdm_sync_process(
    state: *mut SyncState,
    re_ptr: *const f32,
    im_ptr: *const f32,
    len: usize,
    out: *mut f64,
) -> usize {
    let s = match unsafe { state.as_mut() } {
        Some(s) => s,
        None => return 0,
    };
    let re: &[f32] = if re_ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(re_ptr, len) }
    };
    let im: &[f32] = if im_ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(im_ptr, len) }
    };
    let count = s.process(re, im);
    if !out.is_null() {
        let o = unsafe { core::slice::from_raw_parts_mut(out, 5) };
        o[0] = s.last_metric;
        o[1] = s.last_gamma_mag;
        o[2] = s.last_phi;
        match s.last_offset {
            Some(offset) => {
                o[3] = offset;
                o[4] = 1.0;
            }
            None => {
                o[3] = 0.0;
                o[4] = 0.0;
            }
        }
    }
    count
}

#[no_mangle]
pub extern "C" fn ofdm_sync_starts_ptr(state: *const SyncState) -> *const f64 {
    match unsafe { state.as_ref() } {
        Some(s) => s.starts.as_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn ofdm_sync_destroy(state: *mut SyncState) {
    if !state.is_null() {
        unsafe { drop(Box::from_raw(state)) };
    }
}

/// Single-block carrier frequency offset estimate. Writes
/// `[timing_index, metric, fractional_offset_hz]` to `out`.
#[no_mangle]
pub extern "C" fn ofdm_freq_estimate(
    fft_size: usize,
    gi_ratio: usize,
    sample_rate_hz: f64,
    re_ptr: *const f32,
    im_ptr: *const f32,
    len: usize,
    max_search: f64,
    out: *mut f64,
) {
    let n = fft_size;
    let l = n / gi_ratio;
    let mut best_metric = f64::NEG_INFINITY;
    let mut best_index: i64 = -1;
    let mut best_gamma_re = 0.0f64;
    let mut best_gamma_im = 0.0f64;

    let re: &[f32] = if re_ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(re_ptr, len) }
    };
    let im: &[f32] = if im_ptr.is_null() || len == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(im_ptr, len) }
    };

    let limit = (len as f64 - (n + l) as f64).min(max_search);
    let mut start: i64 = 0;
    while (start as f64) <= limit {
        let mut gamma_re = 0.0f64;
        let mut gamma_im = 0.0f64;
        let mut phi = 0.0f64;
        let s = start as usize;
        for i in 0..l {
            let a = s + i;
            let b = a + n;
            let ar = re[a] as f64;
            let ai = im[a] as f64;
            let br = re[b] as f64;
            let bi = im[b] as f64;
            gamma_re += ar * br + ai * bi;
            gamma_im += ai * br - ar * bi;
            phi += 0.5 * (ar * ar + ai * ai + br * br + bi * bi);
        }
        let metric = gamma_re.hypot(gamma_im) - RHO * phi;
        if metric > best_metric {
            best_metric = metric;
            best_index = start;
            best_gamma_re = gamma_re;
            best_gamma_im = gamma_im;
        }
        start += 1;
    }

    let (timing_index, metric, fractional_offset) = if best_index < 0 {
        (-1.0, 0.0, 0.0)
    } else {
        let phase = best_gamma_im.atan2(best_gamma_re);
        let offset = -phase * sample_rate_hz / (2.0 * PI * n as f64);
        (best_index as f64, best_metric, offset)
    };
    if !out.is_null() {
        let o = unsafe { core::slice::from_raw_parts_mut(out, 3) };
        o[0] = timing_index;
        o[1] = metric;
        o[2] = fractional_offset;
    }
}
