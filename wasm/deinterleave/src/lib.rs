//! Deinterleaving kernels for the ISDB-T receiver.
//!
//! Mirrors `src/dsp/stages/deinterleave.ts`: intra-segment frequency
//! (de)interleaving, soft per-carrier bit deinterleaving, convolutional time
//! deinterleaving and the 12-branch byte deinterleaver. Integer/permutation
//! paths are bit-exact with the TypeScript reference.

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

/// Undo the intra-segment frequency interleaving.
#[no_mangle]
pub extern "C" fn frequency_deinterleave(
    perm_ptr: *const u32,
    size: usize,
    in_re: *const f32,
    in_im: *const f32,
    out_re: *mut f32,
    out_im: *mut f32,
    n: usize,
    rotation: i32,
) {
    if perm_ptr.is_null()
        || in_re.is_null()
        || in_im.is_null()
        || out_re.is_null()
        || out_im.is_null()
        || size == 0
    {
        return;
    }
    let perm = unsafe { core::slice::from_raw_parts(perm_ptr, size) };
    let ire = unsafe { core::slice::from_raw_parts(in_re, n) };
    let iim = unsafe { core::slice::from_raw_parts(in_im, n) };
    let ore = unsafe { core::slice::from_raw_parts_mut(out_re, n) };
    let oim = unsafe { core::slice::from_raw_parts_mut(out_im, n) };
    let sz = size as i64;
    let rot = rotation as i64;
    for k in 0..n {
        let idx = (((k as i64 - rot) % sz) + sz) % sz;
        let src = perm[idx as usize] as usize;
        ore[k] = ire[src];
        oim[k] = iim[src];
    }
}

/// Inverse of `frequency_deinterleave`.
#[no_mangle]
pub extern "C" fn frequency_interleave(
    perm_ptr: *const u32,
    size: usize,
    in_re: *const f32,
    in_im: *const f32,
    out_re: *mut f32,
    out_im: *mut f32,
    n: usize,
    rotation: i32,
) {
    if perm_ptr.is_null()
        || in_re.is_null()
        || in_im.is_null()
        || out_re.is_null()
        || out_im.is_null()
        || size == 0
    {
        return;
    }
    let perm = unsafe { core::slice::from_raw_parts(perm_ptr, size) };
    let ire = unsafe { core::slice::from_raw_parts(in_re, n) };
    let iim = unsafe { core::slice::from_raw_parts(in_im, n) };
    let ore = unsafe { core::slice::from_raw_parts_mut(out_re, n) };
    let oim = unsafe { core::slice::from_raw_parts_mut(out_im, n) };
    let sz = size as i64;
    let rot = rotation as i64;
    for k in 0..n {
        let idx = (((k as i64 - rot) % sz) + sz) % sz;
        let dst = perm[idx as usize] as usize;
        ore[dst] = ire[k];
        oim[dst] = iim[k];
    }
}

/// Largest bit deinterleaver delay, in carrier symbols.
const BIT_INTERLEAVER_MAX_DELAY: usize = 120;

pub struct SoftBitDeinterleaver {
    delays: Vec<usize>,
    label_bits: usize,
    history: Vec<i8>,
    pos: usize,
}

/// Create a soft bit deinterleaver with `count` per-label-bit delays.
#[no_mangle]
pub extern "C" fn soft_bit_deinterleaver_create(
    delays_ptr: *const u32,
    count: usize,
) -> *mut SoftBitDeinterleaver {
    if delays_ptr.is_null() || count == 0 {
        return core::ptr::null_mut();
    }
    let delays: Vec<usize> = unsafe { core::slice::from_raw_parts(delays_ptr, count) }
        .iter()
        .map(|&d| d as usize)
        .collect();
    let history = vec![0i8; (BIT_INTERLEAVER_MAX_DELAY + 1) * count];
    Box::into_raw(Box::new(SoftBitDeinterleaver {
        delays,
        label_bits: count,
        history,
        pos: 0,
    }))
}

#[no_mangle]
pub extern "C" fn soft_bit_deinterleaver_destroy(state: *mut SoftBitDeinterleaver) {
    if state.is_null() {
        return;
    }
    unsafe { drop(Box::from_raw(state)) };
}

#[no_mangle]
pub extern "C" fn soft_bit_deinterleaver_reset(state: *mut SoftBitDeinterleaver) {
    if state.is_null() {
        return;
    }
    let s = unsafe { &mut *state };
    for b in s.history.iter_mut() {
        *b = 0;
    }
    s.pos = 0;
}

#[no_mangle]
pub extern "C" fn soft_bit_deinterleaver_process(
    state: *mut SoftBitDeinterleaver,
    input_ptr: *const i8,
    len: usize,
    out_ptr: *mut i8,
) {
    if state.is_null() || input_ptr.is_null() || out_ptr.is_null() {
        return;
    }
    let s = unsafe { &mut *state };
    let input = unsafe { core::slice::from_raw_parts(input_ptr, len) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, len) };
    for b in out.iter_mut() {
        *b = 0;
    }
    let size = BIT_INTERLEAVER_MAX_DELAY + 1;
    let lb = s.label_bits;
    let carriers = len / lb;
    for t in 0..carriers {
        for b in 0..lb {
            s.history[s.pos * lb + b] = input[t * lb + b];
        }
        for b in 0..lb {
            let idx = (s.pos + size - s.delays[b]) % size;
            out[t * lb + b] = s.history[idx * lb + b];
        }
        s.pos = (s.pos + 1) % size;
    }
}

pub struct TimeDeinterleaver {
    interleave_unit: i32,
    depth: Vec<usize>,
    pos: Vec<usize>,
    re: Vec<Vec<f32>>,
    im: Vec<Vec<f32>>,
}

/// Create a convolutional time deinterleaver over `carriers` data carriers.
#[no_mangle]
pub extern "C" fn time_deinterleaver_create(
    carriers: usize,
    interleave_unit: i32,
) -> *mut TimeDeinterleaver {
    let mut depth = Vec::with_capacity(carriers);
    let mut re = Vec::with_capacity(carriers);
    let mut im = Vec::with_capacity(carriers);
    for c in 0..carriers {
        let mi = (5 * c) % 96;
        let d = if interleave_unit <= 0 {
            1
        } else {
            (interleave_unit as i64 * (95 - mi) as i64 + 1) as usize
        };
        depth.push(d);
        re.push(vec![0f32; d]);
        im.push(vec![0f32; d]);
    }
    Box::into_raw(Box::new(TimeDeinterleaver {
        interleave_unit,
        depth,
        pos: vec![0usize; carriers],
        re,
        im,
    }))
}

#[no_mangle]
pub extern "C" fn time_deinterleaver_destroy(state: *mut TimeDeinterleaver) {
    if state.is_null() {
        return;
    }
    unsafe { drop(Box::from_raw(state)) };
}

#[no_mangle]
pub extern "C" fn time_deinterleaver_reset(state: *mut TimeDeinterleaver) {
    if state.is_null() {
        return;
    }
    let s = unsafe { &mut *state };
    for c in 0..s.depth.len() {
        for v in s.re[c].iter_mut() {
            *v = 0.0;
        }
        for v in s.im[c].iter_mut() {
            *v = 0.0;
        }
        s.pos[c] = 0;
    }
}

#[no_mangle]
pub extern "C" fn time_deinterleaver_process(
    state: *mut TimeDeinterleaver,
    in_re: *const f32,
    in_im: *const f32,
    out_re: *mut f32,
    out_im: *mut f32,
    n: usize,
) {
    if state.is_null() || in_re.is_null() || in_im.is_null() || out_re.is_null() || out_im.is_null()
    {
        return;
    }
    let s = unsafe { &mut *state };
    let ire = unsafe { core::slice::from_raw_parts(in_re, n) };
    let iim = unsafe { core::slice::from_raw_parts(in_im, n) };
    let ore = unsafe { core::slice::from_raw_parts_mut(out_re, n) };
    let oim = unsafe { core::slice::from_raw_parts_mut(out_im, n) };
    if s.interleave_unit == 0 {
        for c in 0..n {
            ore[c] = ire[c];
            oim[c] = iim[c];
        }
        return;
    }
    for c in 0..n {
        let depth = s.depth[c];
        let p = s.pos[c];
        let read = (p + 1) % depth;
        s.re[c][p] = ire[c];
        s.im[c][p] = iim[c];
        ore[c] = s.re[c][read];
        oim[c] = s.im[c][read];
        s.pos[c] = read;
    }
}

/// Fused `frequency_deinterleave` followed by `time_deinterleaver_process`.
///
/// Keeps the frequency-deinterleaved plane inside WASM linear memory instead of
/// round-tripping it through the host between the two stages. Both steps write
/// index `c` from index `c`, so the time deinterleave runs in place on `out_*`.
#[no_mangle]
pub extern "C" fn frequency_time_deinterleave(
    state: *mut TimeDeinterleaver,
    perm_ptr: *const u32,
    size: usize,
    in_re: *const f32,
    in_im: *const f32,
    out_re: *mut f32,
    out_im: *mut f32,
    n: usize,
    rotation: i32,
) {
    if state.is_null()
        || perm_ptr.is_null()
        || in_re.is_null()
        || in_im.is_null()
        || out_re.is_null()
        || out_im.is_null()
        || size == 0
        || n == 0
    {
        return;
    }
    unsafe {
        let perm = core::slice::from_raw_parts(perm_ptr, size);
        let ire = core::slice::from_raw_parts(in_re, n);
        let iim = core::slice::from_raw_parts(in_im, n);
        let ore = core::slice::from_raw_parts_mut(out_re, n);
        let oim = core::slice::from_raw_parts_mut(out_im, n);
        let sz = size as i64;
        let rot = rotation as i64;
        for k in 0..n {
            let idx = (((k as i64 - rot) % sz) + sz) % sz;
            let src = perm[idx as usize] as usize;
            ore[k] = ire[src];
            oim[k] = iim[src];
        }
    }
    time_deinterleaver_process(state, out_re, out_im, out_re, out_im, n);
}

const BYTE_INTERLEAVER_BRANCHES: usize = 12;
const BYTE_INTERLEAVER_M: usize = 17;

pub struct ByteDeinterleaver {
    buffers: Vec<Vec<u8>>,
    pos: Vec<usize>,
    index: usize,
}

#[no_mangle]
pub extern "C" fn byte_deinterleaver_create() -> *mut ByteDeinterleaver {
    let mut buffers = Vec::with_capacity(BYTE_INTERLEAVER_BRANCHES);
    for b in 0..BYTE_INTERLEAVER_BRANCHES {
        buffers.push(vec![
            0u8;
            1 + BYTE_INTERLEAVER_M
                * (BYTE_INTERLEAVER_BRANCHES - 1 - b)
        ]);
    }
    Box::into_raw(Box::new(ByteDeinterleaver {
        buffers,
        pos: vec![0usize; BYTE_INTERLEAVER_BRANCHES],
        index: 0,
    }))
}

#[no_mangle]
pub extern "C" fn byte_deinterleaver_destroy(state: *mut ByteDeinterleaver) {
    if state.is_null() {
        return;
    }
    unsafe { drop(Box::from_raw(state)) };
}

#[no_mangle]
pub extern "C" fn byte_deinterleaver_reset(state: *mut ByteDeinterleaver) {
    if state.is_null() {
        return;
    }
    let s = unsafe { &mut *state };
    for b in 0..BYTE_INTERLEAVER_BRANCHES {
        for v in s.buffers[b].iter_mut() {
            *v = 0;
        }
        s.pos[b] = 0;
    }
    s.index = 0;
}

fn byte_process_byte(s: &mut ByteDeinterleaver, value: u8) -> u8 {
    let b = s.index % BYTE_INTERLEAVER_BRANCHES;
    let size = s.buffers[b].len();
    let p = s.pos[b];
    s.buffers[b][p] = value;
    let out = s.buffers[b][(p + 1) % size];
    s.pos[b] = (p + 1) % size;
    s.index += 1;
    out
}

/// Push one byte through the branch selected by the running byte index.
#[no_mangle]
pub extern "C" fn byte_deinterleaver_process_byte(
    state: *mut ByteDeinterleaver,
    value: u32,
) -> u32 {
    if state.is_null() {
        return 0;
    }
    let s = unsafe { &mut *state };
    byte_process_byte(s, value as u8) as u32
}

#[no_mangle]
pub extern "C" fn byte_deinterleaver_process(
    state: *mut ByteDeinterleaver,
    input_ptr: *const u8,
    len: usize,
    out_ptr: *mut u8,
) {
    if state.is_null() || input_ptr.is_null() || out_ptr.is_null() {
        return;
    }
    let s = unsafe { &mut *state };
    let input = unsafe { core::slice::from_raw_parts(input_ptr, len) };
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, len) };
    for i in 0..len {
        out[i] = byte_process_byte(s, input[i]);
    }
}
