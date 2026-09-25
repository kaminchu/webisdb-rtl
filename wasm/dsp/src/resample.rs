//! DC removal, fractional resampling and NCO correction kernels.
//!
//! Mirrors `src/dsp/stages/dcRemoval.ts`, `src/dsp/stages/resample.ts` and
//! `NcoCorrector` in `src/dsp/stages/frequencyCorrection.ts`. State is kept in
//! f64 exactly as the JavaScript reference; complex samples are stored as f32.

use core::f64::consts::PI;

/// One-pole running-mean complex high-pass.
pub struct DcRemoval {
    alpha: f64,
    dc_re: f64,
    dc_im: f64,
}

impl DcRemoval {
    fn new(alpha: f64) -> Self {
        Self {
            alpha,
            dc_re: 0.0,
            dc_im: 0.0,
        }
    }

    fn reset(&mut self) {
        self.dc_re = 0.0;
        self.dc_im = 0.0;
    }

    fn process(&mut self, re: &mut [f32], im: &mut [f32]) {
        let alpha = self.alpha;
        let mut dc_re = self.dc_re;
        let mut dc_im = self.dc_im;
        for i in 0..re.len() {
            dc_re += alpha * (re[i] as f64 - dc_re);
            dc_im += alpha * (im[i] as f64 - dc_im);
            re[i] = (re[i] as f64 - dc_re) as f32;
            im[i] = (im[i] as f64 - dc_im) as f32;
        }
        self.dc_re = dc_re;
        self.dc_im = dc_im;
    }
}

#[no_mangle]
pub extern "C" fn dc_create(alpha: f64) -> *mut DcRemoval {
    Box::into_raw(Box::new(DcRemoval::new(alpha)))
}

#[no_mangle]
pub extern "C" fn dc_destroy(ptr: *mut DcRemoval) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(ptr));
    }
}

#[no_mangle]
pub extern "C" fn dc_reset(ptr: *mut DcRemoval) {
    if ptr.is_null() {
        return;
    }
    unsafe { (*ptr).reset() };
}

#[no_mangle]
pub extern "C" fn dc_process(ptr: *mut DcRemoval, re_ptr: *mut f32, im_ptr: *mut f32, n: usize) {
    if ptr.is_null() || n == 0 {
        return;
    }
    let re = unsafe { core::slice::from_raw_parts_mut(re_ptr, n) };
    let im = unsafe { core::slice::from_raw_parts_mut(im_ptr, n) };
    unsafe { (*ptr).process(re, im) };
}

const HALF_TAPS: usize = 16;
const PHASES: usize = 256;

fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        return 1.0;
    }
    let px = PI * x;
    px.sin() / px
}

/// Dot product of one polyphase tap window against the coefficient table.
/// The accumulation order is fixed regardless of how the stream is chunked, so
/// results stay chunk-size invariant like the scalar reference.
#[inline]
fn fir_dot(input: &[f32], coef: &[f32], taps: usize) -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;
        let mut acc = f64x2_splat(0.0);
        let mut k = 0usize;
        unsafe {
            while k + 4 <= taps {
                let c = v128_load(coef.as_ptr().add(k) as *const v128);
                let lo = f64x2_promote_low_f32x4(c);
                let hi = f64x2_promote_low_f32x4(i32x4_shuffle::<2, 3, 0, 0>(c, c));
                let x = v128_load(input.as_ptr().add(k) as *const v128);
                let xlo = f64x2_promote_low_f32x4(x);
                let xhi = f64x2_promote_low_f32x4(i32x4_shuffle::<2, 3, 0, 0>(x, x));
                acc = f64x2_add(acc, f64x2_add(f64x2_mul(xlo, lo), f64x2_mul(xhi, hi)));
                k += 4;
            }
        }
        let mut sum = f64x2_extract_lane::<0>(acc) + f64x2_extract_lane::<1>(acc);
        while k < taps {
            sum += input[k] as f64 * coef[k] as f64;
            k += 1;
        }
        return sum;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let mut sum = 0.0f64;
        for k in 0..taps {
            sum += input[k] as f64 * coef[k] as f64;
        }
        sum
    }
}

fn build_table(cutoff_norm: f64) -> Vec<f32> {
    let taps = 2 * HALF_TAPS;
    let mut table = vec![0.0f32; PHASES * taps];
    for ph in 0..PHASES {
        let frac = ph as f64 / PHASES as f64;
        let mut sum = 0.0f64;
        for j in -(HALF_TAPS as i64 - 1)..=(HALF_TAPS as i64) {
            let t = j as f64 - frac;
            let window = 0.54 + 0.46 * ((PI * t) / HALF_TAPS as f64).cos();
            let value = 2.0 * cutoff_norm * sinc(2.0 * cutoff_norm * t) * window;
            table[ph * taps + (j + HALF_TAPS as i64 - 1) as usize] = value as f32;
            sum += value;
        }
        let inv = if sum != 0.0 { 1.0 / sum } else { 0.0 };
        for k in 0..taps {
            let idx = ph * taps + k;
            table[idx] = (table[idx] as f64 * inv) as f32;
        }
    }
    table
}

/// Windowed-sinc polyphase fractional resampler.
pub struct FractionalResampler {
    step_int: i64,
    step_frac: f64,
    table: Vec<f32>,
    buf_re: Vec<f32>,
    buf_im: Vec<f32>,
    buf_len: usize,
    base: i64,
    cursor: i64,
    phase: f64,
    out_re: Vec<f32>,
    out_im: Vec<f32>,
}

impl FractionalResampler {
    fn new(src_rate: f64, dst_rate: f64, cutoff_hz: f64) -> Option<Self> {
        if src_rate <= 0.0 || dst_rate <= 0.0 {
            return None;
        }
        let step = src_rate / dst_rate;
        let step_int = step.floor() as i64;
        let step_frac = step - step_int as f64;
        let cutoff_norm = (cutoff_hz / src_rate).min(0.4999);
        let mut rs = Self {
            step_int,
            step_frac,
            table: build_table(cutoff_norm),
            buf_re: vec![0.0; 4096],
            buf_im: vec![0.0; 4096],
            buf_len: 0,
            base: 0,
            cursor: 0,
            phase: 0.0,
            out_re: Vec::new(),
            out_im: Vec::new(),
        };
        rs.reset();
        Some(rs)
    }

    fn reset(&mut self) {
        self.buf_re[..HALF_TAPS].fill(0.0);
        self.buf_im[..HALF_TAPS].fill(0.0);
        self.buf_len = HALF_TAPS;
        self.base = -(HALF_TAPS as i64);
        self.cursor = 0;
        self.phase = 0.0;
    }

    fn append(&mut self, re: &[f32], im: &[f32]) {
        let need = self.buf_len + re.len();
        if need > self.buf_re.len() {
            let mut cap = if self.buf_re.is_empty() {
                1024
            } else {
                self.buf_re.len()
            };
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

    fn process(&mut self, re: &[f32], im: &[f32]) {
        self.append(re, im);
        self.out_re.clear();
        self.out_im.clear();
        let taps = 2 * HALF_TAPS;
        loop {
            let i0 = self.cursor - self.base;
            if i0 + HALF_TAPS as i64 >= self.buf_len as i64 {
                break;
            }
            let mut ph = (self.phase * PHASES as f64).floor() as i64;
            if ph >= PHASES as i64 {
                ph = PHASES as i64 - 1;
            }
            if ph < 0 {
                ph = 0;
            }
            let base_idx = i0 - (HALF_TAPS as i64 - 1);
            let off = ph as usize * taps;
            let coefficients = &self.table[off..off + taps];
            let start = base_idx as usize;
            let input_re = &self.buf_re[start..start + taps];
            let input_im = &self.buf_im[start..start + taps];
            let sr = fir_dot(input_re, coefficients, taps);
            let si = fir_dot(input_im, coefficients, taps);
            self.out_re.push(sr as f32);
            self.out_im.push(si as f32);
            self.phase += self.step_frac;
            self.cursor += self.step_int;
            if self.phase >= 1.0 {
                self.phase -= 1.0;
                self.cursor += 1;
            }
        }

        let keep_from = self.cursor - self.base - (HALF_TAPS as i64 - 1);
        if keep_from > 0 {
            let kf = keep_from as usize;
            self.buf_re.copy_within(kf..self.buf_len, 0);
            self.buf_im.copy_within(kf..self.buf_len, 0);
            self.buf_len -= kf;
            self.base += keep_from;
        }
    }
}

#[no_mangle]
pub extern "C" fn resample_create(
    src_rate: f64,
    dst_rate: f64,
    cutoff_hz: f64,
) -> *mut FractionalResampler {
    match FractionalResampler::new(src_rate, dst_rate, cutoff_hz) {
        Some(rs) => Box::into_raw(Box::new(rs)),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn resample_destroy(ptr: *mut FractionalResampler) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(ptr));
    }
}

#[no_mangle]
pub extern "C" fn resample_reset(ptr: *mut FractionalResampler) {
    if ptr.is_null() {
        return;
    }
    unsafe { (*ptr).reset() };
}

#[no_mangle]
pub extern "C" fn resample_process(
    ptr: *mut FractionalResampler,
    re_ptr: *const f32,
    im_ptr: *const f32,
    n: usize,
) -> usize {
    if ptr.is_null() {
        return 0;
    }
    let re: &[f32] = if n == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(re_ptr, n) }
    };
    let im: &[f32] = if n == 0 {
        &[]
    } else {
        unsafe { core::slice::from_raw_parts(im_ptr, n) }
    };
    let rs = unsafe { &mut *ptr };
    rs.process(re, im);
    rs.out_re.len()
}

#[no_mangle]
pub extern "C" fn resample_out_re(ptr: *const FractionalResampler) -> *const f32 {
    if ptr.is_null() {
        return core::ptr::null();
    }
    unsafe { (*ptr).out_re.as_ptr() }
}

#[no_mangle]
pub extern "C" fn resample_out_im(ptr: *const FractionalResampler) -> *const f32 {
    if ptr.is_null() {
        return core::ptr::null();
    }
    unsafe { (*ptr).out_im.as_ptr() }
}

/// Fused U8 IQ unpack, DC removal and integer decimation.
///
/// A windowed-sinc FIR runs before downsampling: the RTL-SDR hardware still
/// passes surrounding ISDB-T segments, which otherwise alias into one-seg.
/// Only retained outputs evaluate the FIR (one fixed polyphase branch).
pub struct U8Decimator {
    factor: i32,
    phase: i32,
    alpha: f64,
    dc_re: f64,
    dc_im: f64,
    taps: Vec<f64>,
    history_re: Vec<f64>,
    history_im: Vec<f64>,
    cursor: usize,
    out_re: Vec<f32>,
    out_im: Vec<f32>,
}

impl U8Decimator {
    fn new(factor: i32, alpha: f64) -> Self {
        let factor = factor.max(1);
        let len = if factor == 1 { 1 } else { 63 };
        let mid = (len - 1) as f64 / 2.0;
        let mut taps = vec![0.0; len];
        let mut sum = 0.0;
        for (k, tap) in taps.iter_mut().enumerate() {
            let t = k as f64 - mid;
            let window = if mid == 0.0 {
                1.0
            } else {
                0.54 + 0.46 * (PI * t / mid).cos()
            };
            *tap = sinc(t / factor as f64) / factor as f64 * window;
            sum += *tap;
        }
        for tap in &mut taps {
            *tap /= sum;
        }
        Self {
            factor,
            phase: 0,
            alpha,
            dc_re: 0.0,
            dc_im: 0.0,
            taps,
            history_re: vec![0.0; len],
            history_im: vec![0.0; len],
            cursor: 0,
            out_re: Vec::new(),
            out_im: Vec::new(),
        }
    }

    fn reset(&mut self) {
        self.phase = 0;
        self.dc_re = 0.0;
        self.dc_im = 0.0;
        self.history_re.fill(0.0);
        self.history_im.fill(0.0);
        self.cursor = 0;
        self.out_re.clear();
        self.out_im.clear();
    }

    fn process(&mut self, data: &[u8]) {
        self.out_re.clear();
        self.out_im.clear();
        let factor = self.factor;
        let alpha = self.alpha;
        let mut phase = self.phase;
        let mut dc_re = self.dc_re;
        let mut dc_im = self.dc_im;
        let samples = data.len() / 2;
        for s in 0..samples {
            self.history_re[self.cursor] = (data[2 * s] as f64 - 127.5) / 127.5;
            self.history_im[self.cursor] = (data[2 * s + 1] as f64 - 127.5) / 127.5;
            if phase == 0 {
                let mut re = 0.0;
                let mut im = 0.0;
                let mut index = self.cursor;
                for tap in &self.taps {
                    re += tap * self.history_re[index];
                    im += tap * self.history_im[index];
                    index = if index == 0 {
                        self.taps.len() - 1
                    } else {
                        index - 1
                    };
                }
                dc_re += alpha * (re - dc_re);
                dc_im += alpha * (im - dc_im);
                self.out_re.push((re - dc_re) as f32);
                self.out_im.push((im - dc_im) as f32);
            }
            self.cursor = (self.cursor + 1) % self.taps.len();
            phase += 1;
            if phase >= factor {
                phase = 0;
            }
        }
        self.phase = phase;
        self.dc_re = dc_re;
        self.dc_im = dc_im;
    }
}

#[no_mangle]
pub extern "C" fn u8_decim_create(factor: i32, alpha: f64) -> *mut U8Decimator {
    Box::into_raw(Box::new(U8Decimator::new(factor, alpha)))
}

#[no_mangle]
pub extern "C" fn u8_decim_destroy(ptr: *mut U8Decimator) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(ptr));
    }
}

#[no_mangle]
pub extern "C" fn u8_decim_reset(ptr: *mut U8Decimator) {
    if ptr.is_null() {
        return;
    }
    unsafe { (*ptr).reset() };
}

#[no_mangle]
pub extern "C" fn u8_decim_process(ptr: *mut U8Decimator, data_ptr: *const u8, n: usize) -> usize {
    if ptr.is_null() || n == 0 {
        return 0;
    }
    let data = unsafe { core::slice::from_raw_parts(data_ptr, n) };
    let dec = unsafe { &mut *ptr };
    dec.process(data);
    dec.out_re.len()
}

#[no_mangle]
pub extern "C" fn u8_decim_out_re(ptr: *const U8Decimator) -> *const f32 {
    if ptr.is_null() {
        return core::ptr::null();
    }
    unsafe { (*ptr).out_re.as_ptr() }
}

#[no_mangle]
pub extern "C" fn u8_decim_out_im(ptr: *const U8Decimator) -> *const f32 {
    if ptr.is_null() {
        return core::ptr::null();
    }
    unsafe { (*ptr).out_im.as_ptr() }
}

/// Numerically controlled oscillator frequency-offset correction.
pub struct NcoCorrector {
    offset_hz: f64,
    sample_rate_hz: f64,
    phase: f64,
}

impl NcoCorrector {
    fn new(offset_hz: f64, sample_rate_hz: f64) -> Self {
        Self {
            offset_hz,
            sample_rate_hz,
            phase: 0.0,
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }

    fn process(&mut self, re: &mut [f32], im: &mut [f32]) {
        let step = (-2.0 * PI * self.offset_hz) / self.sample_rate_hz;
        let mut phase = self.phase;
        let step_c = step.cos();
        let step_s = step.sin();
        let mut c = 0.0;
        let mut s = 0.0;
        for i in 0..re.len() {
            // Re-anchor the recursive oscillator to bound amplitude/phase drift.
            if i % 256 == 0 {
                c = phase.cos();
                s = phase.sin();
            }
            let r = re[i] as f64;
            let q = im[i] as f64;
            re[i] = (r * c - q * s) as f32;
            im[i] = (r * s + q * c) as f32;
            phase += step;
            if phase > PI {
                phase -= 2.0 * PI;
            } else if phase < -PI {
                phase += 2.0 * PI;
            }
            let next_c = c * step_c - s * step_s;
            s = s * step_c + c * step_s;
            c = next_c;
        }
        self.phase = phase;
    }
}

#[no_mangle]
pub extern "C" fn nco_create(offset_hz: f64, sample_rate_hz: f64) -> *mut NcoCorrector {
    Box::into_raw(Box::new(NcoCorrector::new(offset_hz, sample_rate_hz)))
}

#[no_mangle]
pub extern "C" fn nco_destroy(ptr: *mut NcoCorrector) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(ptr));
    }
}

#[no_mangle]
pub extern "C" fn nco_reset(ptr: *mut NcoCorrector) {
    if ptr.is_null() {
        return;
    }
    unsafe { (*ptr).reset() };
}

#[no_mangle]
pub extern "C" fn nco_set_offset(ptr: *mut NcoCorrector, offset_hz: f64) {
    if ptr.is_null() {
        return;
    }
    unsafe { (*ptr).offset_hz = offset_hz };
}

#[no_mangle]
pub extern "C" fn nco_process(
    ptr: *mut NcoCorrector,
    re_ptr: *mut f32,
    im_ptr: *mut f32,
    n: usize,
) {
    if ptr.is_null() || n == 0 {
        return;
    }
    let re = unsafe { core::slice::from_raw_parts_mut(re_ptr, n) };
    let im = unsafe { core::slice::from_raw_parts_mut(im_ptr, n) };
    unsafe { (*ptr).process(re, im) };
}
