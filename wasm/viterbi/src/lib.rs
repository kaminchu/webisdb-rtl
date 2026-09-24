//! Convolutional (Viterbi) decoder kernel for the ISDB-T receiver.
//!
//! Mirrors `src/dsp/stages/viterbi.ts` exactly: K = 7 mother code with the
//! bit-reversed taps 0x4f/0x6d, depuncturing into erasures, hard/soft batch
//! decode, and the streaming correlation decoder with a fixed traceback.

use core::alloc::Layout;
use std::alloc::{alloc, dealloc};

const G1: u32 = 0x4f;
const G2: u32 = 0x6d;
const NUM_STATES: usize = 64;
const ERASURE: u8 = 2;
const TRACEBACK: usize = 128;

const PUNCTURE_1_2: [u8; 2] = [1, 1];
const PUNCTURE_2_3: [u8; 4] = [1, 1, 0, 1];
const PUNCTURE_3_4: [u8; 6] = [1, 1, 0, 1, 1, 0];
const PUNCTURE_5_6: [u8; 10] = [1, 1, 0, 1, 1, 0, 0, 1, 1, 0];
const PUNCTURE_7_8: [u8; 14] = [1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0];

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

fn puncture_pattern(rate: u32) -> &'static [u8] {
    match rate {
        0 => &PUNCTURE_1_2,
        1 => &PUNCTURE_2_3,
        2 => &PUNCTURE_3_4,
        3 => &PUNCTURE_5_6,
        _ => &PUNCTURE_7_8,
    }
}

fn depuncture(input: &[u8], rate: u32) -> Vec<u8> {
    let pattern = puncture_pattern(rate);
    let period = pattern.len();
    let mut out: Vec<u8> = Vec::with_capacity(input.len() * 2);
    let mut pi = 0usize;
    for &bit in input {
        while pattern[pi % period] == 0 {
            out.push(ERASURE);
            pi += 1;
        }
        out.push(bit & 1);
        pi += 1;
    }
    while out.len() % 2 != 0 {
        out.push(ERASURE);
    }
    out
}

fn depuncture_soft(input: &[i8], rate: u32) -> Vec<i8> {
    let pattern = puncture_pattern(rate);
    let period = pattern.len();
    let mut out: Vec<i8> = Vec::with_capacity(input.len() * 2);
    let mut pi = 0usize;
    for &bit in input {
        while pattern[pi % period] == 0 {
            out.push(0);
            pi += 1;
        }
        out.push(bit);
        pi += 1;
    }
    while out.len() % 2 != 0 {
        out.push(0);
    }
    out
}

fn parity(mut x: u32) -> u32 {
    x ^= x >> 16;
    x ^= x >> 8;
    x ^= x >> 4;
    x &= 0xf;
    (0x6996u32 >> x) & 1
}

fn branch_output(state: usize, input: usize) -> (u8, u8) {
    let reg = ((state << 1) | input) as u32;
    (parity(reg & G1) as u8, parity(reg & G2) as u8)
}

fn hamming(received: u8, expected: u8) -> f64 {
    if received == ERASURE || received == expected {
        0.0
    } else {
        1.0
    }
}

fn traceback(
    steps: usize,
    terminate: bool,
    metrics: &[f64; NUM_STATES],
    decisions: &[u8],
    out: &mut [u8],
) -> usize {
    let mut state = 0usize;
    if !terminate {
        let mut best = f64::INFINITY;
        for s in 0..NUM_STATES {
            if metrics[s] < best {
                best = metrics[s];
                state = s;
            }
        }
    }

    let output_len = if terminate {
        steps.saturating_sub(6)
    } else {
        steps
    };
    let mut current = state;
    for t in (0..steps).rev() {
        if t < output_len && t < out.len() {
            out[t] = (current & 1) as u8;
        }
        current = decisions[t * NUM_STATES + current] as usize;
    }
    output_len
}

fn decode_hard(mother: &[u8], terminate: bool, out: &mut [u8]) -> usize {
    let steps = mother.len() >> 1;
    if steps == 0 {
        return 0;
    }

    let mut metrics = [f64::INFINITY; NUM_STATES];
    metrics[0] = 0.0;
    let mut next = [f64::INFINITY; NUM_STATES];
    let mut decisions = vec![0u8; steps * NUM_STATES];

    for t in 0..steps {
        let r1 = mother[2 * t];
        let r2 = mother[2 * t + 1];
        next.fill(f64::INFINITY);
        let base = t * NUM_STATES;
        for s in 0..NUM_STATES {
            let metric = metrics[s];
            if !metric.is_finite() {
                continue;
            }
            for u in 0..2usize {
                let (o1, o2) = branch_output(s, u);
                let cost = metric + hamming(r1, o1) + hamming(r2, o2);
                let ns = ((s << 1) | u) & (NUM_STATES - 1);
                if cost < next[ns] {
                    next[ns] = cost;
                    decisions[base + ns] = s as u8;
                }
            }
        }
        metrics.copy_from_slice(&next);
    }

    traceback(steps, terminate, &metrics, &decisions, out)
}

fn decode_soft(mother: &[i8], terminate: bool, out: &mut [u8]) -> usize {
    let steps = mother.len() >> 1;
    if steps == 0 {
        return 0;
    }

    let mut metrics = [f64::INFINITY; NUM_STATES];
    metrics[0] = 0.0;
    let mut next = [f64::INFINITY; NUM_STATES];
    let mut decisions = vec![0u8; steps * NUM_STATES];

    for t in 0..steps {
        let s1 = mother[2 * t] as f64;
        let s2 = mother[2 * t + 1] as f64;
        next.fill(f64::INFINITY);
        let base = t * NUM_STATES;
        for s in 0..NUM_STATES {
            let metric = metrics[s];
            if !metric.is_finite() {
                continue;
            }
            for u in 0..2usize {
                let (o1, o2) = branch_output(s, u);
                let t1 = if o1 != 0 { -1.0 } else { 1.0 };
                let t2 = if o2 != 0 { -1.0 } else { 1.0 };
                let cost = metric - s1 * t1 - s2 * t2;
                let ns = ((s << 1) | u) & (NUM_STATES - 1);
                if cost < next[ns] {
                    next[ns] = cost;
                    decisions[base + ns] = s as u8;
                }
            }
        }
        metrics.copy_from_slice(&next);
    }

    traceback(steps, terminate, &metrics, &decisions, out)
}

#[no_mangle]
pub extern "C" fn viterbi_decode(
    in_ptr: *const u8,
    len: usize,
    rate: u32,
    terminate: u32,
    out_ptr: *mut u8,
) -> usize {
    if in_ptr.is_null() || out_ptr.is_null() || len == 0 {
        return 0;
    }
    let input = unsafe { core::slice::from_raw_parts(in_ptr, len) };
    let mother = depuncture(input, rate);
    let steps = mother.len() >> 1;
    if steps == 0 {
        return 0;
    }
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, steps) };
    decode_hard(&mother, terminate != 0, out)
}

#[no_mangle]
pub extern "C" fn viterbi_decode_soft(
    in_ptr: *const i8,
    len: usize,
    rate: u32,
    terminate: u32,
    out_ptr: *mut u8,
) -> usize {
    if in_ptr.is_null() || out_ptr.is_null() || len == 0 {
        return 0;
    }
    let input = unsafe { core::slice::from_raw_parts(in_ptr, len) };
    let mother = depuncture_soft(input, rate);
    let steps = mother.len() >> 1;
    if steps == 0 {
        return 0;
    }
    let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, steps) };
    decode_soft(&mother, terminate != 0, out)
}

pub struct StreamingState {
    rate: u32,
    metrics: [f64; NUM_STATES],
    next: [f64; NUM_STATES],
    decisions: [u8; TRACEBACK * NUM_STATES],
    sign_a: [f64; NUM_STATES],
    sign_b: [f64; NUM_STATES],
    position: usize,
    pair: [f64; 2],
    pair_len: usize,
    step_count: usize,
    byte: u32,
    bits: u32,
}

impl StreamingState {
    fn new(rate: u32) -> Self {
        let mut state = StreamingState {
            rate,
            metrics: [0.0; NUM_STATES],
            next: [0.0; NUM_STATES],
            decisions: [0u8; TRACEBACK * NUM_STATES],
            sign_a: [0.0; NUM_STATES],
            sign_b: [0.0; NUM_STATES],
            position: 0,
            pair: [0.0; 2],
            pair_len: 0,
            step_count: 0,
            byte: 0,
            bits: 0,
        };
        for s in 0..NUM_STATES {
            state.sign_a[s] = if parity((s as u32) & G1) == 0 {
                1.0
            } else {
                -1.0
            };
            state.sign_b[s] = if parity((s as u32) & G2) == 0 {
                1.0
            } else {
                -1.0
            };
        }
        state
    }

    fn reset(&mut self) {
        self.metrics = [0.0; NUM_STATES];
        self.decisions = [0u8; TRACEBACK * NUM_STATES];
        self.position = 0;
        self.pair = [0.0; 2];
        self.pair_len = 0;
        self.step_count = 0;
        self.byte = 0;
        self.bits = 0;
    }

    fn feed_soft(&mut self, soft: i32) -> Option<u8> {
        let pattern = puncture_pattern(self.rate);
        let period = pattern.len();
        let mut emitted: Option<u8> = None;
        loop {
            let keep = pattern[self.position];
            self.position = (self.position + 1) % period;
            self.pair[self.pair_len] = if keep == 1 { soft as f64 } else { 0.0 };
            self.pair_len += 1;
            if self.pair_len == 2 {
                let a = self.pair[0];
                let b = self.pair[1];
                self.pair_len = 0;
                if let Some(byte) = self.step(a, b) {
                    emitted = Some(byte);
                }
            }
            if keep == 1 {
                break;
            }
        }
        emitted
    }

    fn step(&mut self, a: f64, b: f64) -> Option<u8> {
        let slot = (self.step_count % TRACEBACK) * NUM_STATES;
        for state in 0..NUM_STATES {
            let pred = state >> 1;
            let branch = self.sign_a[state] * a + self.sign_b[state] * b;
            let lo = self.metrics[pred] + branch;
            let hi = self.metrics[pred | 32] - branch;
            if lo >= hi {
                self.next[state] = lo;
                self.decisions[slot + state] = pred as u8;
            } else {
                self.next[state] = hi;
                self.decisions[slot + state] = (pred | 32) as u8;
            }
        }

        let mut best = 0usize;
        for s in 1..NUM_STATES {
            if self.next[s] > self.next[best] {
                best = s;
            }
        }
        let max = self.next[best];
        for s in 0..NUM_STATES {
            self.metrics[s] = self.next[s] - max;
        }
        self.step_count += 1;
        if self.step_count < TRACEBACK {
            return None;
        }

        let mut s = best;
        for j in 0..(TRACEBACK - 1) {
            let k = self.step_count - j;
            let decision_slot = (((k - 1) % TRACEBACK) + TRACEBACK) % TRACEBACK;
            s = self.decisions[decision_slot * NUM_STATES + s] as usize;
        }
        self.byte = ((self.byte << 1) | (s as u32 & 1)) & 0xff;
        self.bits += 1;
        if self.bits == 8 {
            self.bits = 0;
            return Some(self.byte as u8);
        }
        None
    }
}

#[no_mangle]
pub extern "C" fn viterbi_stream_create(rate: u32) -> *mut StreamingState {
    Box::into_raw(Box::new(StreamingState::new(rate)))
}

#[no_mangle]
pub extern "C" fn viterbi_stream_destroy(ptr: *mut StreamingState) {
    if ptr.is_null() {
        return;
    }
    unsafe { drop(Box::from_raw(ptr)) };
}

#[no_mangle]
pub extern "C" fn viterbi_stream_reset(ptr: *mut StreamingState) {
    if ptr.is_null() {
        return;
    }
    unsafe { (*ptr).reset() };
}

#[no_mangle]
pub extern "C" fn viterbi_stream_feed_soft(ptr: *mut StreamingState, soft: i32) -> i32 {
    if ptr.is_null() {
        return -1;
    }
    match unsafe { (*ptr).feed_soft(soft) } {
        Some(byte) => byte as i32,
        None => -1,
    }
}

#[no_mangle]
pub extern "C" fn viterbi_stream_feed_soft_block(
    ptr: *mut StreamingState,
    in_ptr: *const i8,
    len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> usize {
    if ptr.is_null() || in_ptr.is_null() || len == 0 {
        return 0;
    }
    let state = unsafe { &mut *ptr };
    let input = unsafe { core::slice::from_raw_parts(in_ptr, len) };
    let out: &mut [u8] = if out_ptr.is_null() || out_cap == 0 {
        &mut []
    } else {
        unsafe { core::slice::from_raw_parts_mut(out_ptr, out_cap) }
    };
    let mut count = 0usize;
    for &soft in input {
        if let Some(byte) = state.feed_soft(soft as i32) {
            if count < out.len() {
                out[count] = byte;
            }
            count += 1;
        }
    }
    count
}
