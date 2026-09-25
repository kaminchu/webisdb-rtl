//! Fused one-seg FEC decoder.
//!
//! Owns the whole receive FEC chain for one-seg layer A:
//!   frequency deinterleave -> time deinterleave -> soft demap ->
//!   soft bit deinterleave -> streaming Viterbi -> byte deinterleave ->
//!   energy descramble -> Reed-Solomon -> TS packet assembly.
//!
//! The host hands over one contiguous batch of equalized data-carrier planes
//! and gets back the MPEG-TS bytes that batch produced. Every intermediate
//! array stays in linear memory, so a batch costs two host copies (input planes
//! and output TS) instead of one boundary crossing per stage per symbol.
//!
//! Mirrors `src/dsp/oneSegDecoder.ts`.

use std::vec::Vec;

use crate::deinterleave::{
    byte_deinterleaver_create, byte_deinterleaver_destroy, byte_deinterleaver_process,
    byte_deinterleaver_reset, frequency_time_deinterleave, soft_bit_deinterleaver_create,
    soft_bit_deinterleaver_destroy, soft_bit_deinterleaver_process, soft_bit_deinterleaver_reset,
    time_deinterleaver_create, time_deinterleaver_destroy, time_deinterleaver_reset,
    ByteDeinterleaver, SoftBitDeinterleaver, TimeDeinterleaver,
};
use crate::demap::demap_demodulate_soft;
use crate::reed_solomon::rs_decode;
use crate::viterbi::{
    viterbi_stream_create, viterbi_stream_destroy, viterbi_stream_feed_soft_block,
    viterbi_stream_reset, StreamingState,
};

const ENERGY_DISPERSAL_INIT: u32 = 0xa9;
const ENERGY_REGISTER_MASK: u32 = 0x7fff;
const RS_CODEWORD_SIZE: usize = 204;
const RS_DATA_SIZE: usize = 188;
const SYNC_BYTE: u8 = 0x47;

fn bits_per_carrier(modulation: u32) -> usize {
    match modulation {
        0 | 1 => 2,
        2 => 4,
        _ => 6,
    }
}

/// Energy-dispersal PRBS mask (x^15 + x^14 + 1), reset per OFDM frame.
fn build_energy_mask(frame_bytes: usize) -> Vec<u8> {
    let mut reg = ENERGY_DISPERSAL_INIT;
    let mut out = vec![0u8; frame_bytes];
    for byte in out.iter_mut() {
        let mut result = 0u32;
        for _ in 0..8 {
            let feedback = ((reg >> 13) ^ (reg >> 14)) & 1;
            reg = ((reg << 1) | feedback) & ENERGY_REGISTER_MASK;
            result = (result << 1) | feedback;
        }
        *byte = result as u8;
    }
    out
}

pub struct OnesegDecoder {
    modulation: u32,
    carriers: usize,
    frame_bytes: usize,
    perm: Vec<u32>,
    time_deint: *mut TimeDeinterleaver,
    bit_deint: *mut SoftBitDeinterleaver,
    byte_deint: *mut ByteDeinterleaver,
    viterbi: *mut StreamingState,
    /// Index (0 or 1) of the plane buffer receiving the current symbol.
    cur: usize,
    plane_re: [Vec<f32>; 2],
    plane_im: [Vec<f32>; 2],
    soft: Vec<i8>,
    soft_out: Vec<i8>,
    decoded: Vec<u8>,
    deint: Vec<u8>,
    has_prev: bool,
    mask: Vec<u8>,
    packet: Vec<u8>,
    byte_index: usize,
    pending: Vec<u8>,
    packets: u32,
    sync_errors: u32,
}

impl OnesegDecoder {
    fn process_symbol(&mut self, in_re: *const f32, in_im: *const f32) {
        let n = self.carriers;
        let cur = self.cur;
        let prev = 1 - cur;

        frequency_time_deinterleave(
            self.time_deint,
            self.perm.as_ptr(),
            self.perm.len(),
            in_re,
            in_im,
            self.plane_re[cur].as_mut_ptr(),
            self.plane_im[cur].as_mut_ptr(),
            n,
            0,
        );

        if self.modulation == 0 && !self.has_prev {
            self.has_prev = true;
            self.cur = prev;
            return;
        }

        demap_demodulate_soft(
            self.modulation,
            self.plane_re[cur].as_ptr(),
            self.plane_im[cur].as_ptr(),
            self.plane_re[prev].as_ptr(),
            self.plane_im[prev].as_ptr(),
            if self.has_prev { 1 } else { 0 },
            self.soft.as_mut_ptr(),
            n,
        );
        self.has_prev = true;
        self.cur = prev;

        let soft_len = n * bits_per_carrier(self.modulation);
        soft_bit_deinterleaver_process(
            self.bit_deint,
            self.soft.as_ptr(),
            soft_len,
            self.soft_out.as_mut_ptr(),
        );
        let count = viterbi_stream_feed_soft_block(
            self.viterbi,
            self.soft_out.as_ptr(),
            soft_len,
            self.decoded.as_mut_ptr(),
            self.decoded.len(),
        );
        if count == 0 {
            return;
        }
        byte_deinterleaver_process(
            self.byte_deint,
            self.decoded.as_ptr(),
            count,
            self.deint.as_mut_ptr(),
        );
        self.push_decoded_bytes(count);
    }

    /// Energy-descramble the byte stream, run RS(204,188) and emit TS packets.
    fn push_decoded_bytes(&mut self, count: usize) {
        for i in 0..count {
            let v = self.deint[i];
            let mask_byte = self.mask[self.byte_index % self.frame_bytes];
            let offset = self.byte_index % RS_CODEWORD_SIZE;
            if offset == RS_CODEWORD_SIZE - 1 {
                self.packet[0] = v;
            } else {
                self.packet[offset + 1] = v ^ mask_byte;
            }
            self.byte_index += 1;
            if offset == RS_CODEWORD_SIZE - 1 {
                let mut data = [0u8; RS_DATA_SIZE];
                let ok = rs_decode(self.packet.as_ptr(), data.as_mut_ptr());
                if ok == 1 && data[0] == SYNC_BYTE {
                    self.pending.extend_from_slice(&data);
                    self.packets += 1;
                }
            }
        }
    }

    fn reset(&mut self) {
        time_deinterleaver_reset(self.time_deint);
        soft_bit_deinterleaver_reset(self.bit_deint);
        byte_deinterleaver_reset(self.byte_deint);
        viterbi_stream_reset(self.viterbi);
        self.cur = 0;
        for buf in self.plane_re.iter_mut().chain(self.plane_im.iter_mut()) {
            for v in buf.iter_mut() {
                *v = 0.0;
            }
        }
        self.has_prev = false;
        self.byte_index = 0;
        self.pending.clear();
        self.packets = 0;
        self.sync_errors = 0;
    }
}

#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn oneseg_decoder_create(
    modulation: u32,
    rate: u32,
    interleave_unit: i32,
    carriers: usize,
    frame_bytes: usize,
    perm_ptr: *const u32,
    perm_size: usize,
    delays_ptr: *const u32,
    delay_count: usize,
) -> *mut OnesegDecoder {
    if perm_ptr.is_null() || perm_size == 0 || delays_ptr.is_null() || delay_count == 0 {
        return core::ptr::null_mut();
    }
    let perm = unsafe { core::slice::from_raw_parts(perm_ptr, perm_size) }.to_vec();
    let time_deint = time_deinterleaver_create(carriers, interleave_unit);
    let bit_deint = soft_bit_deinterleaver_create(delays_ptr, delay_count);
    let byte_deint = byte_deinterleaver_create();
    let viterbi = viterbi_stream_create(rate);
    let bits = bits_per_carrier(modulation);
    let decoded_cap = carriers * bits;
    Box::into_raw(Box::new(OnesegDecoder {
        modulation,
        carriers,
        frame_bytes: frame_bytes.max(1),
        perm,
        time_deint,
        bit_deint,
        byte_deint,
        viterbi,
        cur: 0,
        plane_re: [vec![0.0; carriers], vec![0.0; carriers]],
        plane_im: [vec![0.0; carriers], vec![0.0; carriers]],
        soft: vec![0i8; carriers * bits],
        soft_out: vec![0i8; carriers * bits],
        decoded: vec![0u8; decoded_cap],
        deint: vec![0u8; decoded_cap],
        has_prev: false,
        mask: build_energy_mask(frame_bytes.max(1)),
        packet: vec![0u8; RS_CODEWORD_SIZE],
        byte_index: 0,
        pending: Vec::new(),
        packets: 0,
        sync_errors: 0,
    }))
}

#[no_mangle]
pub extern "C" fn oneseg_decoder_destroy(ptr: *mut OnesegDecoder) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let decoder = Box::from_raw(ptr);
        time_deinterleaver_destroy(decoder.time_deint);
        soft_bit_deinterleaver_destroy(decoder.bit_deint);
        byte_deinterleaver_destroy(decoder.byte_deint);
        viterbi_stream_destroy(decoder.viterbi);
    }
}

#[no_mangle]
pub extern "C" fn oneseg_decoder_reset(ptr: *mut OnesegDecoder) {
    if let Some(decoder) = unsafe { ptr.as_mut() } {
        decoder.reset();
    }
}

/// Decode `symbol_count` equalized data-carrier planes (contiguous, stride
/// `carriers`) and return the number of MPEG-TS bytes this batch produced.
#[no_mangle]
pub extern "C" fn oneseg_decoder_decode_batch(
    ptr: *mut OnesegDecoder,
    planes_re: *const f32,
    planes_im: *const f32,
    symbol_count: usize,
) -> usize {
    let decoder = match unsafe { ptr.as_mut() } {
        Some(d) => d,
        None => return 0,
    };
    if planes_re.is_null() || planes_im.is_null() || symbol_count == 0 {
        return 0;
    }
    decoder.pending.clear();
    let stride = decoder.carriers;
    for s in 0..symbol_count {
        let off = s * stride;
        decoder.process_symbol(unsafe { planes_re.add(off) }, unsafe { planes_im.add(off) });
    }
    decoder.pending.len()
}

#[no_mangle]
pub extern "C" fn oneseg_decoder_ts_ptr(ptr: *const OnesegDecoder) -> *const u8 {
    match unsafe { ptr.as_ref() } {
        Some(d) => d.pending.as_ptr(),
        None => core::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn oneseg_decoder_packets(ptr: *const OnesegDecoder) -> u32 {
    match unsafe { ptr.as_ref() } {
        Some(d) => d.packets,
        None => 0,
    }
}

#[no_mangle]
pub extern "C" fn oneseg_decoder_sync_errors(ptr: *const OnesegDecoder) -> u32 {
    match unsafe { ptr.as_ref() } {
        Some(d) => d.sync_errors,
        None => 0,
    }
}
