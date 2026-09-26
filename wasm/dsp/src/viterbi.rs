//! Convolutional (Viterbi) decoder kernel for the ISDB-T receiver.
//!
//! Mirrors `src/dsp/stages/viterbi.ts` exactly: K = 7 mother code with the
//! bit-reversed taps 0x4f/0x6d, depuncturing into erasures, hard/soft batch
//! decode, and the streaming correlation decoder with a fixed traceback.

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
    metrics: [i32; NUM_STATES],
    next: [i32; NUM_STATES],
    decisions: [u64; TRACEBACK],
    survivor: [u8; TRACEBACK],
    sign_a: [i32; NUM_STATES],
    sign_b: [i32; NUM_STATES],
    position: usize,
    pair: [i32; 2],
    pair_len: usize,
    step_count: usize,
    byte: u32,
    bits: u32,
}

impl StreamingState {
    fn new(rate: u32) -> Self {
        let mut state = StreamingState {
            rate,
            metrics: [0; NUM_STATES],
            next: [0; NUM_STATES],
            decisions: [0u64; TRACEBACK],
            survivor: [0; TRACEBACK],
            sign_a: [0; NUM_STATES],
            sign_b: [0; NUM_STATES],
            position: 0,
            pair: [0; 2],
            pair_len: 0,
            step_count: 0,
            byte: 0,
            bits: 0,
        };
        for s in 0..NUM_STATES {
            state.sign_a[s] = if parity((s as u32) & G1) == 0 { 1 } else { -1 };
            state.sign_b[s] = if parity((s as u32) & G2) == 0 { 1 } else { -1 };
        }
        state
    }

    fn reset(&mut self) {
        self.metrics = [0; NUM_STATES];
        self.decisions = [0u64; TRACEBACK];
        self.position = 0;
        self.pair = [0; 2];
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
            self.pair[self.pair_len] = if keep == 1 { soft } else { 0 };
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

    /// Add-compare-select over all states.
    ///
    /// Inputs are soft i8 (lengthened to i32) and the branch metric is a signed
    /// sum, so the whole decoder stays in integers. Normalising the maximum to
    /// zero after every step bounds the dynamic range well inside i32.
    fn acs(&mut self, a: i32, b: i32) -> usize {
        #[cfg(target_arch = "wasm32")]
        unsafe {
            return self.acs_simd(a, b);
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.acs_scalar(a, b);
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
            best
        }
    }

    #[allow(dead_code)]
    fn acs_scalar(&mut self, a: i32, b: i32) {
        let slot = self.step_count % TRACEBACK;
        let mut bits = 0u64;
        for state in 0..NUM_STATES {
            let pred = state >> 1;
            let branch = self.sign_a[state] * a + self.sign_b[state] * b;
            let lo = self.metrics[pred] + branch;
            let hi = self.metrics[pred | 32] - branch;
            if lo >= hi {
                self.next[state] = lo;
                bits |= 1u64 << state;
            } else {
                self.next[state] = hi;
            }
        }
        self.decisions[slot] = bits;
    }

    /// f32x4-sized i32x4 ACS. Each 4-state block shares two predecessors, so the
    /// `[m0,m0,m1,m1]` / `[m32,m32,m33,m33]` vectors are built with a shuffle.
    #[cfg(target_arch = "wasm32")]
    unsafe fn acs_simd(&mut self, a: i32, b: i32) -> usize {
        use core::arch::wasm32::*;
        let slot = self.step_count % TRACEBACK;
        let va = i32x4_splat(a);
        let vb = i32x4_splat(b);
        let mp = self.metrics.as_ptr();
        let sa = self.sign_a.as_ptr();
        let sb = self.sign_b.as_ptr();
        let nxt = self.next.as_mut_ptr();
        let mut maximum = i32x4_splat(i32::MIN);
        let mut bits = 0u64;
        let mut s = 0usize;
        while s + 4 <= NUM_STATES {
            let m = s >> 1;
            let mlo = v128_load(mp.add(m) as *const v128);
            let pred_lo = i32x4_shuffle::<0, 0, 1, 1>(mlo, mlo);
            // Shift the load window down by two so the last block stays in bounds;
            // lanes 2/3 hold metrics[32+m], metrics[32+m+1].
            let mhi = v128_load(mp.add(m + 30) as *const v128);
            let pred_hi = i32x4_shuffle::<2, 2, 3, 3>(mhi, mhi);
            let br = i32x4_add(
                i32x4_mul(v128_load(sa.add(s) as *const v128), va),
                i32x4_mul(v128_load(sb.add(s) as *const v128), vb),
            );
            let lo = i32x4_add(pred_lo, br);
            let hi = i32x4_sub(pred_hi, br);
            // Set bit s+lane when the low predecessor (state>>1) wins the compare.
            bits |= (i32x4_bitmask(i32x4_ge(lo, hi)) as u64) << s;
            let scores = i32x4_max(lo, hi);
            maximum = i32x4_max(maximum, scores);
            v128_store(nxt.add(s) as *mut v128, scores);
            s += 4;
        }
        self.decisions[slot] = bits;
        maximum = i32x4_max(maximum, i32x4_shuffle::<2, 3, 0, 1>(maximum, maximum));
        maximum = i32x4_max(maximum, i32x4_shuffle::<1, 0, 3, 2>(maximum, maximum));
        let mut best = NUM_STATES;
        for s in (0..NUM_STATES).step_by(4) {
            let scores = v128_load(nxt.add(s) as *const v128);
            // Equal metrics must choose the lowest state, just like the scalar decoder.
            let mask = i32x4_bitmask(i32x4_eq(scores, maximum));
            if best == NUM_STATES && mask != 0 {
                best = s + mask.trailing_zeros() as usize;
            }
            v128_store(self.metrics.as_mut_ptr().add(s) as *mut v128, i32x4_sub(scores, maximum));
        }
        best
    }

    fn step(&mut self, a: i32, b: i32) -> Option<u8> {
        let best = self.acs(a, b);
        self.step_count += 1;
        if self.step_count < TRACEBACK {
            return None;
        }

        let mut s = best;
        self.survivor[self.step_count % TRACEBACK] = s as u8;
        let target = (self.step_count - (TRACEBACK - 1)) % TRACEBACK;
        for j in 0..(TRACEBACK - 1) {
            let k = self.step_count - j;
            let decision_slot = (k - 1) % TRACEBACK;
            let bit = (self.decisions[decision_slot] >> s) & 1;
            s = (s >> 1) | if bit == 1 { 0 } else { 32 };
            // Once this path merges into the previous traceback, its entire older
            // suffix is identical. Reuse it without shortening the traceback depth.
            if self.step_count > TRACEBACK && self.survivor[decision_slot] == s as u8 {
                s = self.survivor[target] as usize;
                break;
            }
            self.survivor[decision_slot] = s as u8;
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
