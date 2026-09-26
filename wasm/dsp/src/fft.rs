//! Radix-2 FFT kernels for the ISDB-T receiver.
//!
//! The `fft_forward`/`fft_inverse` entry points mirror `src/dsp/stages/fft.ts`
//! exactly (f64 butterflies, sequential twiddle update) and stay as the batch
//! precision reference. `FftPlan` is the reusable locked-path kernel: bit
//! reversal and per-stage twiddles are precomputed in f64 and stored as f32, and
//! the butterflies run as f32x4 SIMD on wasm32 with a scalar fallback elsewhere.

use core::f64::consts::PI;

use std::vec::Vec;

fn transform(re: &mut [f32], im: &mut [f32], sign: f64) {
    let n = re.len();
    if n <= 1 {
        return;
    }

    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    let mut len = 2usize;
    while len <= n {
        let ang = sign * 2.0 * PI / len as f64;
        let wr = ang.cos();
        let wi = ang.sin();
        let half = len >> 1;
        let mut i = 0usize;
        while i < n {
            let mut cur_r = 1.0f64;
            let mut cur_i = 0.0f64;
            for k in 0..half {
                let a = i + k;
                let b = a + half;
                let br = re[b] as f64;
                let bi = im[b] as f64;
                let vr = br * cur_r - bi * cur_i;
                let vi = br * cur_i + bi * cur_r;
                let ar = re[a] as f64;
                let ai = im[a] as f64;
                re[b] = (ar - vr) as f32;
                im[b] = (ai - vi) as f32;
                re[a] = (ar + vr) as f32;
                im[a] = (ai + vi) as f32;
                let nr = cur_r * wr - cur_i * wi;
                cur_i = cur_r * wi + cur_i * wr;
                cur_r = nr;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// In-place forward FFT (sign -1).
#[no_mangle]
pub extern "C" fn fft_forward(re_ptr: *mut f32, im_ptr: *mut f32, n: usize) {
    if re_ptr.is_null() || im_ptr.is_null() || n <= 1 {
        return;
    }
    let re = unsafe { core::slice::from_raw_parts_mut(re_ptr, n) };
    let im = unsafe { core::slice::from_raw_parts_mut(im_ptr, n) };
    transform(re, im, -1.0);
}

/// In-place inverse FFT (sign +1) with 1/N scaling.
#[no_mangle]
pub extern "C" fn fft_inverse(re_ptr: *mut f32, im_ptr: *mut f32, n: usize) {
    if re_ptr.is_null() || im_ptr.is_null() || n <= 1 {
        return;
    }
    let re = unsafe { core::slice::from_raw_parts_mut(re_ptr, n) };
    let im = unsafe { core::slice::from_raw_parts_mut(im_ptr, n) };
    transform(re, im, 1.0);
    let scale = 1.0 / n as f64;
    for i in 0..n {
        re[i] = (re[i] as f64 * scale) as f32;
        im[i] = (im[i] as f64 * scale) as f32;
    }
}

/// Precomputed radix-2 plan for one transform size.
///
/// Twiddles are generated once in f64 (using the forward sign -1) and stored as
/// f32 per stage so consecutive butterflies read a contiguous f32x4 window. The
/// inverse reuses the table with the imaginary part negated.
pub struct FftPlan {
    n: usize,
    rev: Vec<u32>,
    tw_re: Vec<f32>,
    tw_im: Vec<f32>,
    stage_off: Vec<usize>,
}

impl FftPlan {
    pub fn new(n: usize) -> Self {
        let bits = n.trailing_zeros();
        let mut rev = Vec::with_capacity(n);
        for i in 0..n {
            let mut x = i;
            let mut r = 0usize;
            for _ in 0..bits {
                r = (r << 1) | (x & 1);
                x >>= 1;
            }
            rev.push(r as u32);
        }

        let mut tw_re: Vec<f32> = Vec::with_capacity(n.saturating_sub(1));
        let mut tw_im: Vec<f32> = Vec::with_capacity(n.saturating_sub(1));
        let mut stage_off: Vec<usize> = Vec::with_capacity(bits as usize);
        let mut len = 2usize;
        while len <= n {
            stage_off.push(tw_re.len());
            let half = len >> 1;
            let ang = -2.0 * PI / len as f64;
            for k in 0..half {
                let a = ang * k as f64;
                tw_re.push(a.cos() as f32);
                tw_im.push(a.sin() as f32);
            }
            len <<= 1;
        }

        Self {
            n,
            rev,
            tw_re,
            tw_im,
            stage_off,
        }
    }

    pub fn forward(&self, re: &mut [f32], im: &mut [f32]) {
        self.transform(re, im, false);
    }

    pub fn inverse(&self, re: &mut [f32], im: &mut [f32]) {
        self.transform(re, im, true);
        let scale = 1.0 / self.n as f64;
        for v in re.iter_mut() {
            *v = (*v as f64 * scale) as f32;
        }
        for v in im.iter_mut() {
            *v = (*v as f64 * scale) as f32;
        }
    }

    fn transform(&self, re: &mut [f32], im: &mut [f32], inverse: bool) {
        let n = self.n;
        if n <= 1 || re.len() < n || im.len() < n {
            return;
        }
        for i in 0..n {
            let j = self.rev[i] as usize;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }

        let sign = if inverse { -1.0f32 } else { 1.0f32 };

        #[cfg(target_arch = "wasm32")]
        let (rp, ip): (*mut f32, *mut f32) = (re.as_mut_ptr(), im.as_mut_ptr());

        let mut len = 2usize;
        let mut stage = 0usize;
        while len <= n {
            let half = len >> 1;
            let off = self.stage_off[stage];
            let mut base = 0usize;
            while base < n {
                let mut k = 0usize;
                #[cfg(target_arch = "wasm32")]
                unsafe {
                    use core::arch::wasm32::*;
                    while k + 4 <= half {
                        let ar = v128_load(rp.add(base + k) as *const v128);
                        let ai = v128_load(ip.add(base + k) as *const v128);
                        let br = v128_load(rp.add(base + half + k) as *const v128);
                        let bi = v128_load(ip.add(base + half + k) as *const v128);
                        let wr = v128_load(self.tw_re.as_ptr().add(off + k) as *const v128);
                        let wi = f32x4_mul(
                            v128_load(self.tw_im.as_ptr().add(off + k) as *const v128),
                            f32x4_splat(sign),
                        );
                        let vr = f32x4_sub(f32x4_mul(br, wr), f32x4_mul(bi, wi));
                        let vi = f32x4_add(f32x4_mul(br, wi), f32x4_mul(bi, wr));
                        v128_store(rp.add(base + k) as *mut v128, f32x4_add(ar, vr));
                        v128_store(ip.add(base + k) as *mut v128, f32x4_add(ai, vi));
                        v128_store(rp.add(base + half + k) as *mut v128, f32x4_sub(ar, vr));
                        v128_store(ip.add(base + half + k) as *mut v128, f32x4_sub(ai, vi));
                        k += 4;
                    }
                }
                while k < half {
                    let a = base + k;
                    let b = a + half;
                    let wr = self.tw_re[off + k];
                    let wi = self.tw_im[off + k] * sign;
                    let br = re[b];
                    let bi = im[b];
                    let vr = br * wr - bi * wi;
                    let vi = br * wi + bi * wr;
                    let ar = re[a];
                    let ai = im[a];
                    re[b] = ar - vr;
                    im[b] = ai - vi;
                    re[a] = ar + vr;
                    im[a] = ai + vi;
                    k += 1;
                }
                base += len;
            }
            len <<= 1;
            stage += 1;
        }
    }
}

#[no_mangle]
pub extern "C" fn fft_plan_create(n: usize) -> *mut FftPlan {
    if n == 0 || n & (n - 1) != 0 {
        return core::ptr::null_mut();
    }
    Box::into_raw(Box::new(FftPlan::new(n)))
}

#[no_mangle]
pub extern "C" fn fft_plan_destroy(ptr: *mut FftPlan) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(ptr)) };
    }
}

#[no_mangle]
pub extern "C" fn fft_plan_forward(ptr: *const FftPlan, re_ptr: *mut f32, im_ptr: *mut f32) {
    let plan = match unsafe { ptr.as_ref() } {
        Some(p) => p,
        None => return,
    };
    if re_ptr.is_null() || im_ptr.is_null() {
        return;
    }
    let n = plan.n;
    let re = unsafe { core::slice::from_raw_parts_mut(re_ptr, n) };
    let im = unsafe { core::slice::from_raw_parts_mut(im_ptr, n) };
    plan.forward(re, im);
}

#[no_mangle]
pub extern "C" fn fft_plan_inverse(ptr: *const FftPlan, re_ptr: *mut f32, im_ptr: *mut f32) {
    let plan = match unsafe { ptr.as_ref() } {
        Some(p) => p,
        None => return,
    };
    if re_ptr.is_null() || im_ptr.is_null() {
        return;
    }
    let n = plan.n;
    let re = unsafe { core::slice::from_raw_parts_mut(re_ptr, n) };
    let im = unsafe { core::slice::from_raw_parts_mut(im_ptr, n) };
    plan.inverse(re, im);
}
