//! Radix-2 iterative FFT kernel for the ISDB-T receiver.
//!
//! Mirrors `src/dsp/stages/fft.ts`: forward sign -1, inverse sign +1 with 1/N
//! scaling. Butterflies and twiddle updates are computed in f64 and stored back
//! as f32, matching the JavaScript number semantics of the reference.

use core::alloc::Layout;
use core::f64::consts::PI;
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
