//! Fused locked-state front end.
//!
//! Owns the sample buffer, NCO derotation, OFDM tracking synchronizer, FFT, TMCC
//! extraction/decoding and channel estimation/equalization/demapping for the
//! steady-state (locked) path. Samples enter once per host chunk and equalized
//! data-carrier planes accumulate in linear memory, so no FFT bin or intermediate
//! plane round-trips through the host per OFDM symbol.
//!
//! Mirrors the locked half of `src/dsp/pipeline.ts`.

use std::vec::Vec;

use crate::demap::demap_process_symbol;
use crate::fft::batch_windows;
use crate::ofdm::{
    ofdm_sync_create, ofdm_sync_destroy, ofdm_sync_process, ofdm_sync_reset, ofdm_sync_starts_ptr,
    SyncState,
};
use crate::resample::{nco_create, nco_destroy, nco_process, nco_reset, NcoCorrector};
use crate::tmcc::TmccDecoder;

const MER_INTERVAL: usize = 4;
const SYNC_FIELDS: usize = 5;

pub struct Frontend {
    n: usize,
    gi: usize,
    cps: usize,
    dc: usize,
    carrier_base: i64,
    sp_offset: usize,
    frame_start: usize,
    alpha: f64,
    nco: *mut NcoCorrector,
    sync: *mut SyncState,
    tmcc: TmccDecoder,
    tmcc_carriers: Vec<u32>,
    fft_re: Vec<f32>,
    fft_im: Vec<f32>,
    fft_scratch_re: Vec<f32>,
    fft_scratch_im: Vec<f32>,
    tmcc_re: Vec<f32>,
    tmcc_im: Vec<f32>,
    seg_ref: Vec<f32>,
    bins_re: Vec<f32>,
    bins_im: Vec<f32>,
    h_re: Vec<f32>,
    h_im: Vec<f32>,
    prev_re: Vec<f32>,
    prev_im: Vec<f32>,
    has_prev: bool,
    data_ptrs: Vec<Vec<u32>>,
    buf_re: Vec<f32>,
    buf_im: Vec<f32>,
    buf_len: usize,
    buf_start: i64,
    derotated_up_to: usize,
    sync_fed: usize,
    pending_re: Vec<f32>,
    pending_im: Vec<f32>,
    pending_count: usize,
    symbol_index: usize,
    symbols_processed: u64,
    last_gamma_mag: f64,
    last_phi: f64,
    last_signal_power: f64,
    last_mer_db: f64,
    sync_out: [f64; SYNC_FIELDS],
    stats_out: [f64; 5],
}

impl Frontend {
    fn append(&mut self, re: &[f32], im: &[f32]) {
        let need = self.buf_len + re.len();
        if need > self.buf_re.len() {
            let mut cap = if self.buf_re.is_empty() { 4096 } else { self.buf_re.len() };
            while cap < need {
                cap <<= 1;
            }
            self.buf_re.resize(cap, 0.0);
            self.buf_im.resize(cap, 0.0);
        }
        self.buf_re[self.buf_len..need].copy_from_slice(re);
        self.buf_im[self.buf_len..need].copy_from_slice(im);
        self.buf_len = need;
    }

    fn drop_front(&mut self, count: usize) {
        if count == 0 || count > self.buf_len {
            return;
        }
        self.buf_re.copy_within(count..self.buf_len, 0);
        self.buf_im.copy_within(count..self.buf_len, 0);
        self.buf_len -= count;
        self.buf_start += count as i64;
        self.derotated_up_to = self.derotated_up_to.saturating_sub(count);
        self.sync_fed = self.sync_fed.saturating_sub(count);
    }

    fn ensure_pending(&mut self, need: usize) {
        if need <= self.pending_re.len() {
            return;
        }
        let mut cap = if self.pending_re.is_empty() { self.dc * 32 } else { self.pending_re.len() };
        while cap < need {
            cap <<= 1;
        }
        self.pending_re.resize(cap, 0.0);
        self.pending_im.resize(cap, 0.0);
    }

    fn ensure_fft_scratch(&mut self, need: usize) {
        if need <= self.fft_scratch_re.len() {
            return;
        }
        self.fft_scratch_re.resize(need, 0.0);
        self.fft_scratch_im.resize(need, 0.0);
    }

    /// Run the stateful half of `process_symbol` on the FFT result already
    /// stored at `off` in the scratch planes. The FFTs themselves are computed
    /// for the whole chunk up front by [`batch_windows`].
    fn process_symbol_bins(&mut self, off: usize) {
        self.fft_re[..self.n].copy_from_slice(&self.fft_scratch_re[off..off + self.n]);
        self.fft_im[..self.n].copy_from_slice(&self.fft_scratch_im[off..off + self.n]);

        let angle = -2.0
            * core::f64::consts::PI
            * (self.carrier_base as f64 + self.cps as f64 / 2.0)
            * self.symbol_index as f64
            / self.gi as f64;
        let cos = angle.cos();
        let sin = angle.sin();
        let n = self.n as i64;
        for c in 0..self.tmcc_carriers.len() {
            let bin = (((self.carrier_base + self.tmcc_carriers[c] as i64) % n + n) % n) as usize;
            let re = self.fft_re[bin] as f64;
            let im = self.fft_im[bin] as f64;
            self.tmcc_re[c] = (re * cos - im * sin) as f32;
            self.tmcc_im[c] = (re * sin + im * cos) as f32;
        }
        self.tmcc.push(&self.tmcc_re, &self.tmcc_im);

        if self.symbol_index >= self.frame_start {
            let sp_phase = (self.symbol_index + self.sp_offset) % 4;
            let offset = self.pending_count * self.dc;
            self.ensure_pending(offset + self.dc);
            demap_process_symbol(
                self.fft_re.as_ptr(),
                self.fft_im.as_ptr(),
                self.n,
                self.carrier_base as i32,
                self.bins_re.as_mut_ptr(),
                self.bins_im.as_mut_ptr(),
                self.seg_ref.as_ptr(),
                self.h_re.as_mut_ptr(),
                self.h_im.as_mut_ptr(),
                self.prev_re.as_mut_ptr(),
                self.prev_im.as_mut_ptr(),
                if self.has_prev { 1 } else { 0 },
                sp_phase,
                self.cps,
                self.alpha,
                self.data_ptrs[sp_phase].as_ptr(),
                self.dc,
                self.pending_re[offset..].as_mut_ptr(),
                self.pending_im[offset..].as_mut_ptr(),
            );
            self.has_prev = true;
            if self.symbol_index % MER_INTERVAL == 0 {
                self.update_mer(offset);
            }
            self.pending_count += 1;
        }
        self.symbols_processed += 1;
        self.symbol_index += 1;
    }

    fn update_mer(&mut self, offset: usize) {
        let mut power = 0.0f64;
        for i in 0..self.dc {
            let r = self.pending_re[offset + i] as f64;
            let q = self.pending_im[offset + i] as f64;
            power += r * r + q * q;
        }
        power /= self.dc as f64;
        self.last_signal_power = power;
        let scale = (power / 2.0).sqrt();
        let mut err = 0.0f64;
        for i in 0..self.dc {
            let r = self.pending_re[offset + i] as f64;
            let q = self.pending_im[offset + i] as f64;
            let ideal_re = if r >= 0.0 { scale } else { -scale };
            let ideal_im = if q >= 0.0 { scale } else { -scale };
            err += (r - ideal_re) * (r - ideal_re) + (q - ideal_im) * (q - ideal_im);
        }
        err /= self.dc as f64;
        self.last_mer_db = if power > 0.0 && err > 0.0 {
            10.0 * (power / err).log10()
        } else {
            f64::NAN
        };
    }

    fn push(&mut self, re: &[f32], im: &[f32]) -> usize {
        self.append(re, im);
        if self.derotated_up_to < self.buf_len {
            let len = self.buf_len - self.derotated_up_to;
            nco_process(
                self.nco,
                self.buf_re[self.derotated_up_to..].as_mut_ptr(),
                self.buf_im[self.derotated_up_to..].as_mut_ptr(),
                len,
            );
            self.derotated_up_to = self.buf_len;
        }
        if self.sync_fed < self.buf_len {
            let len = self.buf_len - self.sync_fed;
            let count = ofdm_sync_process(
                self.sync,
                self.buf_re[self.sync_fed..].as_ptr(),
                self.buf_im[self.sync_fed..].as_ptr(),
                len,
                self.sync_out.as_mut_ptr(),
            );
            self.sync_fed = self.buf_len;
            self.last_gamma_mag = self.sync_out[1];
            self.last_phi = self.sync_out[2];
            let starts = ofdm_sync_starts_ptr(self.sync);
            let mut rels: Vec<i32> = Vec::with_capacity(count);
            for i in 0..count {
                let rel = unsafe { *starts.add(i) } as i64 - self.buf_start;
                if rel < 0 || rel as usize + self.n > self.buf_len {
                    continue;
                }
                rels.push(rel as i32);
            }
            if !rels.is_empty() {
                let n = self.n;
                self.ensure_fft_scratch(rels.len() * n);
                let buf_re: &[f32] = &self.buf_re;
                let buf_im: &[f32] = &self.buf_im;
                let scratch_re: &mut [f32] = &mut self.fft_scratch_re;
                let scratch_im: &mut [f32] = &mut self.fft_scratch_im;
                batch_windows(buf_re, buf_im, &rels, n, scratch_re, scratch_im);
                for i in 0..rels.len() {
                    self.process_symbol_bins(i * n);
                }
            }
            let drop = if self.buf_len > 2 * self.n { self.buf_len - 2 * self.n } else { 0 };
            self.drop_front(drop);
        }
        self.pending_count
    }

    fn reset(&mut self) {
        nco_reset(self.nco);
        ofdm_sync_reset(self.sync);
        self.tmcc.reset();
        self.buf_len = 0;
        self.buf_start = 0;
        self.derotated_up_to = 0;
        self.sync_fed = 0;
        self.pending_count = 0;
        self.symbol_index = 0;
        self.symbols_processed = 0;
        self.has_prev = false;
        self.last_gamma_mag = 0.0;
        self.last_phi = 0.0;
        self.last_signal_power = 0.0;
        self.last_mer_db = f64::NAN;
    }
}

impl Drop for Frontend {
    fn drop(&mut self) {
        nco_destroy(self.nco);
        ofdm_sync_destroy(self.sync);
    }
}

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn frontend_create(
    mode: u32,
    fft_size: usize,
    gi: usize,
    sample_rate_hz: f64,
    carrier_base: i32,
    fractional_offset_hz: f64,
    sp_offset: usize,
    frame_start_symbol: usize,
    alpha: f64,
    cps: usize,
    dc: usize,
    seg_ref_ptr: *const f32,
    data_idx_ptr: *const u32,
    tmcc_ptr: *const u32,
    tmcc_count: usize,
) -> *mut Frontend {
    if seg_ref_ptr.is_null()
        || data_idx_ptr.is_null()
        || tmcc_ptr.is_null()
        || cps == 0
        || dc == 0
        || tmcc_count == 0
    {
        return core::ptr::null_mut();
    }
    let seg_ref = unsafe { core::slice::from_raw_parts(seg_ref_ptr, cps) }.to_vec();
    let data_flat = unsafe { core::slice::from_raw_parts(data_idx_ptr, 4 * dc) };
    let data_ptrs: Vec<Vec<u32>> = (0..4)
        .map(|p| data_flat[p * dc..(p + 1) * dc].to_vec())
        .collect();
    let tmcc_carriers = unsafe { core::slice::from_raw_parts(tmcc_ptr, tmcc_count) }.to_vec();
    let nco = nco_create(fractional_offset_hz, sample_rate_hz);
    let sync = ofdm_sync_create(fft_size, gi, sample_rate_hz, 1);
    let mut tmcc = TmccDecoder::new(mode, Some(gi as u32));
    tmcc.reset();
    Box::into_raw(Box::new(Frontend {
        n: fft_size,
        gi,
        cps,
        dc,
        carrier_base: carrier_base as i64,
        sp_offset,
        frame_start: frame_start_symbol,
        alpha,
        nco,
        sync,
        tmcc,
        tmcc_carriers,
        fft_re: vec![0.0; fft_size],
        fft_im: vec![0.0; fft_size],
        fft_scratch_re: Vec::new(),
        fft_scratch_im: Vec::new(),
        tmcc_re: vec![0.0; tmcc_count],
        tmcc_im: vec![0.0; tmcc_count],
        seg_ref,
        bins_re: vec![0.0; cps],
        bins_im: vec![0.0; cps],
        h_re: vec![0.0; cps],
        h_im: vec![0.0; cps],
        prev_re: vec![0.0; cps],
        prev_im: vec![0.0; cps],
        has_prev: false,
        data_ptrs,
        buf_re: Vec::new(),
        buf_im: Vec::new(),
        buf_len: 0,
        buf_start: 0,
        derotated_up_to: 0,
        sync_fed: 0,
        pending_re: Vec::new(),
        pending_im: Vec::new(),
        pending_count: 0,
        symbol_index: 0,
        symbols_processed: 0,
        last_gamma_mag: 0.0,
        last_phi: 0.0,
        last_signal_power: 0.0,
        last_mer_db: f64::NAN,
        sync_out: [0.0; SYNC_FIELDS],
        stats_out: [0.0; 5],
    }))
}

#[no_mangle]
pub extern "C" fn frontend_destroy(ptr: *mut Frontend) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(ptr)) };
    }
}

#[no_mangle]
pub extern "C" fn frontend_reset(ptr: *mut Frontend) {
    if let Some(f) = unsafe { ptr.as_mut() } {
        f.reset();
    }
}

/// Append samples and return the number of pending equalized symbol planes.
#[no_mangle]
pub extern "C" fn frontend_push(
    ptr: *mut Frontend,
    re_ptr: *const f32,
    im_ptr: *const f32,
    len: usize,
) -> usize {
    let f = match unsafe { ptr.as_mut() } {
        Some(f) => f,
        None => return 0,
    };
    let (re, im): (&[f32], &[f32]) = if re_ptr.is_null() || im_ptr.is_null() || len == 0 {
        (&[], &[])
    } else {
        unsafe {
            (
                core::slice::from_raw_parts(re_ptr, len),
                core::slice::from_raw_parts(im_ptr, len),
            )
        }
    };
    f.push(re, im)
}

#[no_mangle]
pub extern "C" fn frontend_pending_re(ptr: *const Frontend) -> *const f32 {
    match unsafe { ptr.as_ref() } {
        Some(f) => f.pending_re.as_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn frontend_pending_im(ptr: *const Frontend) -> *const f32 {
    match unsafe { ptr.as_ref() } {
        Some(f) => f.pending_im.as_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn frontend_pending_count(ptr: *const Frontend) -> usize {
    match unsafe { ptr.as_ref() } {
        Some(f) => f.pending_count,
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn frontend_clear_pending(ptr: *mut Frontend) {
    if let Some(f) = unsafe { ptr.as_mut() } {
        f.pending_count = 0;
    }
}

/// `[gamma_magnitude, phi, signal_power, mer_db (NaN when null), symbols]`.
#[no_mangle]
pub extern "C" fn frontend_write_stats(ptr: *const Frontend, out: *mut f64) {
    let f = match unsafe { ptr.as_ref() } {
        Some(f) => f,
        None => return,
    };
    if out.is_null() {
        return;
    }
    let stats = [
        f.last_gamma_mag,
        f.last_phi,
        f.last_signal_power,
        f.last_mer_db,
        f.symbols_processed as f64,
    ];
    unsafe {
        core::ptr::copy_nonoverlapping(stats.as_ptr(), out, stats.len());
    }
}

#[no_mangle]
pub extern "C" fn frontend_tmcc_version(ptr: *const Frontend) -> u32 {
    match unsafe { ptr.as_ref() } {
        Some(f) => f.tmcc.updates(),
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn frontend_write_tmcc(ptr: *const Frontend, out: *mut u32) {
    if let Some(f) = unsafe { ptr.as_ref() } {
        crate::tmcc::tmcc_decoder_write_info(&f.tmcc, out);
    }
}

#[no_mangle]
pub extern "C" fn frontend_write_tmcc_bits(ptr: *const Frontend, out: *mut u8) {
    if let Some(f) = unsafe { ptr.as_ref() } {
        crate::tmcc::tmcc_decoder_write_bits(&f.tmcc, out);
    }
}
