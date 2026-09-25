//! TMCC (Transmission and Multiplexing Configuration Control) decoder.
//!
//! Mirrors `src/dsp/stages/tmcc.ts`: 204-bit frame buffering with a 16-bit frame
//! sync phase search, DBPSK in the time direction, per-frame soft majority
//! accumulation, field extraction and the shortened (184,102) DSC parity
//! syndrome. Lock is asserted after two consecutive consistent majority frames.

const SYNC_BITS: usize = 16;
const TMCC_BITS_PER_FRAME: usize = 204;
const INFO_OFFSET: usize = 19;
const PHASE_SEARCH_BITS: usize = 2 * TMCC_BITS_PER_FRAME + SYNC_BITS;
const SYNC_TOLERANCE: i32 = 2;

const SYNC_EVEN: [u8; SYNC_BITS] = [0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0];
const SYNC_ODD: [u8; SYNC_BITS] = [1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1];

const DSC_CHECK_POLY: [u8; 192] = [
    1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0,
    0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0,
    1, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 1, 1,
    1, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0,
    0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0,
    1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1,
];

fn tmcc_per_segment(mode: u32) -> usize {
    match mode {
        1 => 1,
        2 => 2,
        _ => 4,
    }
}

fn sync_distance(bits: &[u8], offset: usize) -> (i32, i32) {
    let mut even = 0i32;
    let mut odd = 0i32;
    for i in 0..SYNC_BITS {
        let b = bits[offset + i];
        if b != SYNC_EVEN[i] {
            even += 1;
        }
        if b != SYNC_ODD[i] {
            odd += 1;
        }
    }
    (even, odd)
}

fn min_sync_distance(bits: &[u8]) -> i32 {
    let (even, odd) = sync_distance(bits, 0);
    even.min(odd)
}

fn match_sync_word(bits: &[u8]) -> bool {
    let (even, odd) = sync_distance(bits, 0);
    even == 0 || odd == 0
}

fn dsc_syndrome_count(codeword184: &[u8]) -> i32 {
    let mut block = [0u8; 273];
    block[89..89 + 184].copy_from_slice(&codeword184[..184]);
    let mut errors = 0i32;
    for j in 0..82 {
        let mut s = 0u8;
        for i in 0..192 {
            s ^= block[i + j] & DSC_CHECK_POLY[i];
        }
        if s != 0 {
            errors += 1;
        }
    }
    errors
}

fn bits_to_int(bits: &[u8], start: usize, length: usize) -> u32 {
    let mut v = 0u32;
    for i in 0..length {
        v = (v << 1) | bits[start + i] as u32;
    }
    v
}

#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub struct TmccLayer {
    pub modulation: u8,
    pub code_rate: u8,
    pub time_interleave: u8,
    pub segments: u8,
}

#[derive(Clone)]
pub struct TmccInfo {
    pub locked: bool,
    pub mode: Option<u32>,
    pub gi_ratio: Option<u32>,
    pub partial_reception: bool,
    pub system_descriptor: Option<u8>,
    pub layers: [Option<TmccLayer>; 3],
    pub frame_count: u32,
}

impl TmccInfo {
    fn empty() -> Self {
        TmccInfo {
            locked: false,
            mode: None,
            gi_ratio: None,
            partial_reception: false,
            system_descriptor: None,
            layers: [None, None, None],
            frame_count: 0,
        }
    }

    fn consistency_key(&self) -> String {
        let layer_key = |l: &Option<TmccLayer>| match l {
            Some(v) => format!(
                "{}/{}/{}/{}",
                v.modulation, v.code_rate, v.time_interleave, v.segments
            ),
            None => "-".to_string(),
        };
        format!(
            "{:?}|{}|{}|{}|{}|{}",
            self.mode,
            self.system_descriptor.unwrap_or(255),
            self.partial_reception as u8,
            layer_key(&self.layers[0]),
            layer_key(&self.layers[1]),
            layer_key(&self.layers[2]),
        )
    }
}

fn decode_layer(bits: &[u8], start: usize) -> Option<TmccLayer> {
    let modulation = bits_to_int(bits, start, 3) as u8;
    let code_rate = bits_to_int(bits, start + 3, 3) as u8;
    let time_interleave = bits_to_int(bits, start + 6, 3) as u8;
    let segments = bits_to_int(bits, start + 9, 4) as u8;
    if modulation == 7 || segments == 0 {
        return None;
    }
    Some(TmccLayer {
        modulation,
        code_rate,
        time_interleave,
        segments,
    })
}

fn decode_tmcc_bits(bits: &[u8], mode: Option<u32>, gi_ratio: Option<u32>) -> TmccInfo {
    let parity_errors = dsc_syndrome_count(&bits[INFO_OFFSET..INFO_OFFSET + 184]);
    TmccInfo {
        locked: match_sync_word(bits) && parity_errors == 0,
        mode,
        gi_ratio,
        partial_reception: bits[26] == 1,
        system_descriptor: Some(bits_to_int(bits, INFO_OFFSET, 2) as u8),
        layers: [
            decode_layer(bits, 27),
            decode_layer(bits, 40),
            decode_layer(bits, 53),
        ],
        frame_count: 1,
    }
}

pub struct TmccDecoder {
    mode: u32,
    gi_ratio: Option<u32>,
    carriers: usize,
    prev_re: Vec<f32>,
    prev_im: Vec<f32>,
    have_prev: bool,
    phase_search: Vec<u8>,
    phase_pos: i64,
    total_bits: i64,
    frame_start_bit: i64,
    accum: [i16; TMCC_BITS_PER_FRAME],
    frame: [u8; TMCC_BITS_PER_FRAME],
    accum_frames: i64,
    locked: bool,
    consistent: i32,
    last_key: String,
    last_info: TmccInfo,
    updates: u32,
    bits: [u8; TMCC_BITS_PER_FRAME],
}

impl TmccDecoder {
    pub fn new(mode: u32, gi_ratio: Option<u32>) -> Self {
        let mut info = TmccInfo::empty();
        info.mode = Some(mode);
        info.gi_ratio = gi_ratio;
        TmccDecoder {
            mode,
            gi_ratio,
            carriers: tmcc_per_segment(mode),
            prev_re: vec![0.0; tmcc_per_segment(mode)],
            prev_im: vec![0.0; tmcc_per_segment(mode)],
            have_prev: false,
            phase_search: Vec::new(),
            phase_pos: -1,
            total_bits: 0,
            frame_start_bit: -1,
            accum: [0; TMCC_BITS_PER_FRAME],
            frame: [0; TMCC_BITS_PER_FRAME],
            accum_frames: 0,
            locked: false,
            consistent: 0,
            last_key: String::new(),
            last_info: info,
            updates: 0,
            bits: [0; TMCC_BITS_PER_FRAME],
        }
    }

    pub fn reset(&mut self) {
        self.have_prev = false;
        self.phase_search.clear();
        self.phase_pos = -1;
        self.total_bits = 0;
        self.frame_start_bit = -1;
        self.accum = [0; TMCC_BITS_PER_FRAME];
        self.accum_frames = 0;
        self.locked = false;
        self.consistent = 0;
        self.last_key.clear();
        let mut info = TmccInfo::empty();
        info.mode = Some(self.mode);
        info.gi_ratio = self.gi_ratio;
        self.last_info = info;
        self.updates = self.updates.wrapping_add(1);
        self.bits = [0; TMCC_BITS_PER_FRAME];
    }

    pub fn updates(&self) -> u32 {
        self.updates
    }

    /// 0-based symbol index of the current frame's B1, or -1 if not phase-locked.
    pub fn frame_start_symbol(&self) -> i32 {
        if self.frame_start_bit < 0 {
            -1
        } else {
            (self.frame_start_bit + 1) as i32
        }
    }

    pub fn push(&mut self, re: &[f32], im: &[f32]) {
        if !self.have_prev {
            self.prev_re[..self.carriers].copy_from_slice(&re[..self.carriers]);
            self.prev_im[..self.carriers].copy_from_slice(&im[..self.carriers]);
            self.have_prev = true;
            return;
        }
        let mut vote = 0i32;
        for k in 0..self.carriers {
            let dr = re[k] * self.prev_re[k] + im[k] * self.prev_im[k];
            vote += if dr >= 0.0 { 1 } else { -1 };
            self.prev_re[k] = re[k];
            self.prev_im[k] = im[k];
        }
        self.feed_bit(if vote >= 0 { 0 } else { 1 });
    }

    fn feed_bit(&mut self, bit: u8) {
        self.total_bits += 1;
        if self.phase_pos < 0 {
            self.phase_search.push(bit);
            if self.phase_search.len() >= PHASE_SEARCH_BITS {
                self.acquire_phase();
            }
            return;
        }

        self.frame[self.phase_pos as usize] = bit;
        self.phase_pos += 1;
        if self.phase_pos >= TMCC_BITS_PER_FRAME as i64 {
            self.phase_pos = 0;
            let frame = self.frame;
            self.accumulate_frame(&frame);
            self.accum_frames += 1;
            if self.accum_frames > 1000 {
                for a in self.accum.iter_mut() {
                    *a >>= 1;
                }
            }
            self.decode_accumulated();
        }
    }

    fn accumulate_frame(&mut self, frame: &[u8]) {
        let (even, odd) = sync_distance(frame, 0);
        for i in 0..TMCC_BITS_PER_FRAME {
            let bit = if i < SYNC_BITS && odd < even {
                frame[i] ^ 1
            } else {
                frame[i]
            };
            self.accum[i] += if bit != 0 { 1 } else { -1 };
        }
    }

    fn acquire_phase(&mut self) {
        let len = self.phase_search.len();
        let mut best: i64 = -1;
        let mut best_avg = -1.0f64;
        let mut best_count = 0usize;
        for p in 0..TMCC_BITS_PER_FRAME {
            let mut score = 0i32;
            let mut count = 0usize;
            let mut q = p;
            while q + SYNC_BITS <= len {
                score += SYNC_BITS as i32 - min_sync_distance(&self.phase_search[q..]);
                count += 1;
                q += TMCC_BITS_PER_FRAME;
            }
            if count < 2 {
                continue;
            }
            let avg = score as f64 / count as f64;
            if avg > best_avg || (avg == best_avg && count > best_count) {
                best_avg = avg;
                best = p as i64;
                best_count = count;
            }
        }
        if best < 0 || best_avg < 12.0 {
            let cap = 4 * TMCC_BITS_PER_FRAME + SYNC_BITS;
            if self.phase_search.len() > cap {
                let drop = self.phase_search.len() - cap;
                self.phase_search.drain(0..drop);
            }
            return;
        }

        self.accum = [0; TMCC_BITS_PER_FRAME];
        let run = len as i64 - best;
        self.frame_start_bit = self.total_bits - len as i64 + best;
        self.accum_frames = run / TMCC_BITS_PER_FRAME as i64;
        for i in 0..self.accum_frames {
            let start = best as usize + i as usize * TMCC_BITS_PER_FRAME;
            let bits = self.phase_search[start..start + TMCC_BITS_PER_FRAME].to_vec();
            self.accumulate_frame(&bits);
        }
        self.phase_pos = run % TMCC_BITS_PER_FRAME as i64;
        let tail_start = best as usize + self.accum_frames as usize * TMCC_BITS_PER_FRAME;
        let tail = &self.phase_search[tail_start..];
        let copy_len = tail.len().min(TMCC_BITS_PER_FRAME);
        self.frame[..copy_len].copy_from_slice(&tail[..copy_len]);
        self.phase_search.clear();
        self.consistent = 0;
        self.last_key.clear();
        if self.accum_frames >= 1 {
            self.decode_accumulated();
        }
    }

    fn decode_accumulated(&mut self) {
        for i in 0..TMCC_BITS_PER_FRAME {
            self.bits[i] = if self.accum[i] > 0 { 1 } else { 0 };
        }
        self.updates = self.updates.wrapping_add(1);
        if min_sync_distance(&self.bits) > SYNC_TOLERANCE + 2 {
            self.phase_pos = -1;
            self.phase_search.clear();
            self.accum = [0; TMCC_BITS_PER_FRAME];
            self.accum_frames = 0;
            self.consistent = 0;
            self.last_key.clear();
            self.locked = false;
            self.last_info.locked = false;
            return;
        }
        let info = decode_tmcc_bits(&self.bits, Some(self.mode), self.gi_ratio);
        if !info.locked {
            self.consistent = 0;
            self.locked = false;
            self.last_info = info;
            self.last_info.locked = false;
            self.last_info.frame_count = self.accum_frames as u32;
            return;
        }
        let key = info.consistency_key();
        if key == self.last_key {
            self.consistent += 1;
        } else {
            self.consistent = 1;
        }
        self.last_key = key;
        if self.consistent >= 2 {
            self.locked = true;
        }
        self.last_info = info;
        self.last_info.locked = self.locked;
        self.last_info.frame_count = self.accum_frames as u32;
    }
}

#[no_mangle]
pub extern "C" fn tmcc_decoder_create(mode: u32, gi_ratio: i32) -> *mut TmccDecoder {
    let gi = if gi_ratio < 0 {
        None
    } else {
        Some(gi_ratio as u32)
    };
    Box::into_raw(Box::new(TmccDecoder::new(mode, gi)))
}

#[no_mangle]
pub extern "C" fn tmcc_decoder_destroy(ptr: *mut TmccDecoder) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(ptr)) };
    }
}

#[no_mangle]
pub extern "C" fn tmcc_decoder_reset(ptr: *mut TmccDecoder) {
    if let Some(d) = unsafe { ptr.as_mut() } {
        d.reset();
    }
}

#[no_mangle]
pub extern "C" fn tmcc_decoder_push(
    ptr: *mut TmccDecoder,
    re_ptr: *const f32,
    im_ptr: *const f32,
) -> u32 {
    let d = match unsafe { ptr.as_mut() } {
        Some(d) => d,
        None => return 0,
    };
    if re_ptr.is_null() || im_ptr.is_null() {
        return d.updates;
    }
    let re = unsafe { core::slice::from_raw_parts(re_ptr, d.carriers) };
    let im = unsafe { core::slice::from_raw_parts(im_ptr, d.carriers) };
    d.push(re, im);
    d.updates
}

/// Packed info layout (21 u32): locked, partial, system(-1 = none), frame_count,
/// mode, gi_ratio, then A/B/C as present, modulation, code_rate, time_interleave,
/// segments each.
#[no_mangle]
pub extern "C" fn tmcc_decoder_write_info(ptr: *const TmccDecoder, out: *mut u32) {
    let d = match unsafe { ptr.as_ref() } {
        Some(d) => d,
        None => return,
    };
    if out.is_null() {
        return;
    }
    let info = &d.last_info;
    let mut fields = [0u32; 21];
    fields[0] = info.locked as u32;
    fields[1] = info.partial_reception as u32;
    fields[2] = info.system_descriptor.map(|v| v as u32).unwrap_or(u32::MAX);
    fields[3] = info.frame_count;
    fields[4] = info.mode.unwrap_or(0);
    fields[5] = info.gi_ratio.unwrap_or(0);
    for (i, layer) in info.layers.iter().enumerate() {
        let base = 6 + i * 5;
        match layer {
            Some(l) => {
                fields[base] = 1;
                fields[base + 1] = l.modulation as u32;
                fields[base + 2] = l.code_rate as u32;
                fields[base + 3] = l.time_interleave as u32;
                fields[base + 4] = l.segments as u32;
            }
            None => fields[base] = 0,
        }
    }
    unsafe {
        core::ptr::copy_nonoverlapping(fields.as_ptr(), out, fields.len());
    }
}

#[no_mangle]
pub extern "C" fn tmcc_decoder_write_bits(ptr: *const TmccDecoder, out: *mut u8) {
    let d = match unsafe { ptr.as_ref() } {
        Some(d) => d,
        None => return,
    };
    if out.is_null() {
        return;
    }
    unsafe {
        core::ptr::copy_nonoverlapping(d.bits.as_ptr(), out, TMCC_BITS_PER_FRAME);
    }
}

#[no_mangle]
pub extern "C" fn tmcc_decoder_frame_start_symbol(ptr: *const TmccDecoder) -> i32 {
    match unsafe { ptr.as_ref() } {
        Some(d) => d.frame_start_symbol(),
        None => -1,
    }
}
