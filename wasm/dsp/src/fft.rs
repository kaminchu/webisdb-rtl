//! Radix-2 iterative FFT kernel for the ISDB-T receiver.
//!
//! Mirrors `src/dsp/stages/fft.ts`: forward sign -1, inverse sign +1 with 1/N
//! scaling. Butterflies and twiddle updates are computed in f64 and stored back
//! as f32, matching the JavaScript number semantics of the reference.

use core::f64::consts::PI;

#[cfg(feature = "threads")]
use rayon::prelude::*;

pub(crate) fn transform(re: &mut [f32], im: &mut [f32], sign: f64) {
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

/// Forward-transform several length-`n` windows `starts[i]` of `buf` into
/// `out_re`/`out_im` (stride `n`). Windows that do not fit are zeroed.
///
/// This is the only kernel exposed to Rayon: the locked front end calls it once
/// per host chunk so all symbol FFTs of the chunk run on the thread pool, while
/// the stateful TMCC/demap pass stays sequential.
pub(crate) fn batch_windows(
    buf_re: &[f32],
    buf_im: &[f32],
    starts: &[i32],
    n: usize,
    out_re: &mut [f32],
    out_im: &mut [f32],
) {
    if n == 0 {
        return;
    }
    let count = starts
        .len()
        .min(out_re.len() / n)
        .min(out_im.len() / n);
    let out_re = &mut out_re[..count * n];
    let out_im = &mut out_im[..count * n];

    let one = |i: usize, ore: &mut [f32], oim: &mut [f32]| {
        let start = starts[i] as usize;
        if start + n <= buf_re.len() && start + n <= buf_im.len() {
            ore.copy_from_slice(&buf_re[start..start + n]);
            oim.copy_from_slice(&buf_im[start..start + n]);
            transform(ore, oim, -1.0);
        } else {
            ore.fill(0.0);
            oim.fill(0.0);
        }
    };

    #[cfg(feature = "threads")]
    out_re
        .par_chunks_mut(n)
        .zip(out_im.par_chunks_mut(n))
        .enumerate()
        .for_each(|(i, (ore, oim))| one(i, ore, oim));

    #[cfg(not(feature = "threads"))]
    for (i, (ore, oim)) in out_re.chunks_mut(n).zip(out_im.chunks_mut(n)).enumerate() {
        one(i, ore, oim);
    }
}

/// FFI wrapper around [`batch_windows`] for the acquisition scan.
#[no_mangle]
pub extern "C" fn fft_batch(
    re_ptr: *const f32,
    im_ptr: *const f32,
    total: usize,
    starts_ptr: *const i32,
    count: usize,
    n: usize,
    out_re_ptr: *mut f32,
    out_im_ptr: *mut f32,
) {
    if re_ptr.is_null()
        || im_ptr.is_null()
        || starts_ptr.is_null()
        || out_re_ptr.is_null()
        || out_im_ptr.is_null()
        || n == 0
        || count == 0
    {
        return;
    }
    let buf_re = unsafe { core::slice::from_raw_parts(re_ptr, total) };
    let buf_im = unsafe { core::slice::from_raw_parts(im_ptr, total) };
    let starts = unsafe { core::slice::from_raw_parts(starts_ptr, count) };
    let out_re = unsafe { core::slice::from_raw_parts_mut(out_re_ptr, count * n) };
    let out_im = unsafe { core::slice::from_raw_parts_mut(out_im_ptr, count * n) };
    batch_windows(buf_re, buf_im, starts, n, out_re, out_im);
}
