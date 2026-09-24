//! Reed-Solomon RS(204,188) decoder kernel for the ISDB-T receiver.
//!
//! Mirrors `src/dsp/stages/reedSolomon.ts` exactly: GF(2^8) with primitive
//! polynomial 0x11d, shortened from RS(255,239) with 51 implicit zero symbols,
//! t = 8. Returns 0 (uncorrectable) instead of a corrected block.

use core::alloc::Layout;
use std::alloc::{alloc, dealloc};

const PRIMITIVE: u16 = 0x11d;
const FIELD_SIZE: usize = 255;
const PARITY_SYMBOLS: usize = 16;
const SHORTENED_PREFIX: usize = 51;
const RS_BLOCK_SIZE: usize = 204;
const RS_DATA_SIZE: usize = 188;

struct Tables {
    exp: [u8; FIELD_SIZE * 2],
    log: [u8; 256],
}

const fn build_tables() -> Tables {
    let mut exp = [0u8; FIELD_SIZE * 2];
    let mut log = [0u8; 256];
    let mut x: u16 = 1;
    let mut i = 0;
    while i < FIELD_SIZE {
        exp[i] = x as u8;
        log[x as usize] = i as u8;
        x <<= 1;
        if x & 0x100 != 0 {
            x ^= PRIMITIVE;
        }
        i += 1;
    }
    let mut i = FIELD_SIZE;
    while i < FIELD_SIZE * 2 {
        exp[i] = exp[i - FIELD_SIZE];
        i += 1;
    }
    Tables { exp, log }
}

static TABLES: Tables = build_tables();

fn gf_mul(a: u8, b: u8) -> u8 {
    if a == 0 || b == 0 {
        return 0;
    }
    TABLES.exp[TABLES.log[a as usize] as usize + TABLES.log[b as usize] as usize]
}

fn gf_div(a: u8, b: u8) -> u8 {
    if a == 0 {
        return 0;
    }
    TABLES.exp[TABLES.log[a as usize] as usize - TABLES.log[b as usize] as usize + FIELD_SIZE]
}

fn gf_inv(a: u8) -> u8 {
    TABLES.exp[FIELD_SIZE - TABLES.log[a as usize] as usize]
}

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

fn syndromes(full: &[u8]) -> [u8; PARITY_SYMBOLS] {
    let mut s = [0u8; PARITY_SYMBOLS];
    for i in 0..PARITY_SYMBOLS {
        let mut acc = 0u8;
        for j in 0..full.len() {
            if full[j] == 0 {
                continue;
            }
            acc ^= gf_mul(full[j], TABLES.exp[(i * (full.len() - 1 - j)) % FIELD_SIZE]);
        }
        s[i] = acc;
    }
    s
}

fn all_zero(values: &[u8]) -> bool {
    values.iter().all(|&v| v == 0)
}

fn berlekamp_massey(s: &[u8; PARITY_SYMBOLS]) -> Vec<u8> {
    let mut sigma: Vec<u8> = vec![1];
    let mut previous: Vec<u8> = vec![1];
    let mut l = 0usize;
    let mut m = 1usize;
    let mut scale = 1u8;
    for n in 0..PARITY_SYMBOLS {
        let mut discrepancy = s[n];
        for i in 1..=l {
            discrepancy ^= gf_mul(if i < sigma.len() { sigma[i] } else { 0 }, s[n - i]);
        }
        if discrepancy == 0 {
            m += 1;
        } else if 2 * l <= n {
            let saved = sigma.clone();
            let factor = gf_div(discrepancy, scale);
            for i in 0..previous.len() {
                let idx = i + m;
                if idx >= sigma.len() {
                    sigma.resize(idx + 1, 0);
                }
                sigma[idx] ^= gf_mul(factor, previous[i]);
            }
            l = n + 1 - l;
            previous = saved;
            scale = discrepancy;
            m = 1;
        } else {
            let factor = gf_div(discrepancy, scale);
            for i in 0..previous.len() {
                let idx = i + m;
                if idx >= sigma.len() {
                    sigma.resize(idx + 1, 0);
                }
                sigma[idx] ^= gf_mul(factor, previous[i]);
            }
            m += 1;
        }
    }
    sigma
}

fn eval_poly(poly: &[u8], x: u8) -> u8 {
    let mut acc = 0u8;
    let mut i = poly.len();
    while i > 0 {
        i -= 1;
        acc = gf_mul(acc, x) ^ poly[i];
    }
    acc
}

fn chien_search(sigma: &[u8]) -> Vec<usize> {
    let mut positions = Vec::new();
    for j in 0..FIELD_SIZE {
        let root = TABLES.exp[(j + 1) % FIELD_SIZE];
        if eval_poly(sigma, root) == 0 {
            positions.push(j);
        }
    }
    positions
}

fn forney(s: &[u8; PARITY_SYMBOLS], sigma: &[u8], positions: &[usize]) -> Vec<u8> {
    let mut omega = [0u8; PARITY_SYMBOLS];
    for i in 0..PARITY_SYMBOLS {
        let mut acc = 0u8;
        for j in 0..=i {
            acc ^= gf_mul(s[j], if i - j < sigma.len() { sigma[i - j] } else { 0 });
        }
        omega[i] = acc;
    }

    let mut derivative = vec![0u8; sigma.len().saturating_sub(1)];
    for i in 1..sigma.len() {
        derivative[i - 1] = if i % 2 == 1 { sigma[i] } else { 0 };
    }

    let mut magnitudes = Vec::with_capacity(positions.len());
    for &j in positions {
        let x = TABLES.exp[(((FIELD_SIZE - 1 - j) % FIELD_SIZE) + FIELD_SIZE) % FIELD_SIZE];
        let x_inv = gf_inv(x);
        let numerator = gf_mul(x, eval_poly(&omega, x_inv));
        let denominator = eval_poly(&derivative, x_inv);
        if denominator == 0 {
            return Vec::new();
        }
        magnitudes.push(gf_div(numerator, denominator));
    }
    magnitudes
}

fn decode_block(block: &[u8]) -> Option<Vec<u8>> {
    if block.len() != RS_BLOCK_SIZE {
        return None;
    }
    let mut full = [0u8; FIELD_SIZE];
    full[SHORTENED_PREFIX..SHORTENED_PREFIX + RS_BLOCK_SIZE].copy_from_slice(block);

    let s = syndromes(&full);
    if all_zero(&s) {
        return Some(block[..RS_DATA_SIZE].to_vec());
    }

    let sigma = berlekamp_massey(&s);
    let positions = chien_search(&sigma);
    let degree = sigma
        .iter()
        .enumerate()
        .fold(0usize, |acc, (i, &v)| if i > 0 && v != 0 { i } else { acc });
    if positions.is_empty() || positions.len() != degree || positions.len() > 8 {
        return None;
    }

    let magnitudes = forney(&s, &sigma, &positions);
    if magnitudes.len() != positions.len() {
        return None;
    }

    for (i, &p) in positions.iter().enumerate() {
        full[p] ^= magnitudes[i];
    }

    if !all_zero(&syndromes(&full)) {
        return None;
    }
    Some(full[SHORTENED_PREFIX..SHORTENED_PREFIX + RS_DATA_SIZE].to_vec())
}

/// Decode a 204-byte RS(204,188) codeword into `out_ptr` (188 bytes).
/// Returns 1 on success, 0 when uncorrectable.
#[no_mangle]
pub extern "C" fn rs_decode(in_ptr: *const u8, out_ptr: *mut u8) -> u32 {
    if in_ptr.is_null() || out_ptr.is_null() {
        return 0;
    }
    let input = unsafe { core::slice::from_raw_parts(in_ptr, RS_BLOCK_SIZE) };
    match decode_block(input) {
        Some(data) => {
            let out = unsafe { core::slice::from_raw_parts_mut(out_ptr, RS_DATA_SIZE) };
            out.copy_from_slice(&data);
            1
        }
        None => 0,
    }
}
