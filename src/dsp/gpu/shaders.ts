/**
 * WGSL compute kernels for the WebGPU OFDM front end.
 *
 * `fft_main` derotates each symbol window by the constant carrier offset and
 * runs a batched radix-2 forward FFT (one invocation per symbol, the window
 * staged contiguously in `sampleRe/Im`). `demap_main` extracts the center
 * segment, forms the LS channel estimate at the scattered pilots with linear
 * interpolation and edge hold, zero-forcing equalizes the requested data
 * carriers and copies the TMCC carriers for host-side decoding.
 *
 * Both kernels mirror the corresponding Rust kernels in `wasm/dsp/src/fft.rs`,
 * `frontend.rs` and `demap.rs`.
 */

export const OFDM_FRONTEND_WGSL = /* wgsl */ `
struct Params {
  fftSize: u32,
  count: u32,
  carrierBase: i32,
  cps: u32,
  dc: u32,
  tmccCount: u32,
  frameStart: u32,
  spOffset: u32,
  firstDecoded: u32,
  gi: u32,
  sampleRate: f32,
  fractionalOffsetHz: f32,
};

@group(0) @binding(0) var<storage, read> sampleRe: array<f32>;
@group(0) @binding(1) var<storage, read> sampleIm: array<f32>;
@group(0) @binding(2) var<storage, read_write> fftRe: array<f32>;
@group(0) @binding(3) var<storage, read_write> fftIm: array<f32>;
@group(0) @binding(4) var<storage, read> symbolMeta: array<u32>;
@group(0) @binding(5) var<uniform> params: Params;

@compute @workgroup_size(64)
fn fft_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= params.count) {
    return;
  }
  let n = params.fftSize;
  let base = s * n;
  let start = i32(symbolMeta[2u * s]);
  let step = -6.283185307179586 * params.fractionalOffsetHz / params.sampleRate;
  for (var i: u32 = 0u; i < n; i = i + 1u) {
    let phase = step * f32(start + i32(i));
    let c = cos(phase);
    let sn = sin(phase);
    let r = sampleRe[base + i];
    let q = sampleIm[base + i];
    fftRe[base + i] = r * c - q * sn;
    fftIm[base + i] = r * sn + q * c;
  }

  var j: u32 = 0u;
  for (var i: u32 = 1u; i < n; i = i + 1u) {
    var bit = n >> 1u;
    loop {
      if ((j & bit) == 0u) {
        break;
      }
      j = j ^ bit;
      bit = bit >> 1u;
    }
    j = j ^ bit;
    if (i < j) {
      let a = base + i;
      let b = base + j;
      let tr = fftRe[a];
      fftRe[a] = fftRe[b];
      fftRe[b] = tr;
      let ti = fftIm[a];
      fftIm[a] = fftIm[b];
      fftIm[b] = ti;
    }
  }

  var len: u32 = 2u;
  loop {
    if (len > n) {
      break;
    }
    let ang = -6.283185307179586 / f32(len);
    let wr = cos(ang);
    let wi = sin(ang);
    let half = len >> 1u;
    var i: u32 = 0u;
    loop {
      if (i >= n) {
        break;
      }
      var curR = 1.0;
      var curI = 0.0;
      for (var k: u32 = 0u; k < half; k = k + 1u) {
        let a = base + i + k;
        let b = a + half;
        let vr = fftRe[b] * curR - fftIm[b] * curI;
        let vi = fftRe[b] * curI + fftIm[b] * curR;
        fftRe[b] = fftRe[a] - vr;
        fftIm[b] = fftIm[a] - vi;
        fftRe[a] = fftRe[a] + vr;
        fftIm[a] = fftIm[a] + vi;
        let nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
      i = i + len;
    }
    len = len << 1u;
  }
}
`

export const DEMAP_WGSL = /* wgsl */ `
struct Params {
  fftSize: u32,
  count: u32,
  carrierBase: i32,
  cps: u32,
  dc: u32,
  tmccCount: u32,
  frameStart: u32,
  spOffset: u32,
  firstDecoded: u32,
  gi: u32,
  sampleRate: f32,
  fractionalOffsetHz: f32,
};

@group(0) @binding(0) var<storage, read> fftRe: array<f32>;
@group(0) @binding(1) var<storage, read> fftIm: array<f32>;
@group(0) @binding(2) var<storage, read> symbolMeta: array<u32>;
@group(0) @binding(3) var<storage, read> dataIdx: array<u32>;
@group(0) @binding(4) var<storage, read> segRef: array<f32>;
@group(0) @binding(5) var<storage, read> tmccCarriers: array<u32>;
@group(0) @binding(6) var<storage, read_write> out: array<f32>;
@group(0) @binding(7) var<storage, read_write> tmccOut: array<f32>;
@group(0) @binding(8) var<uniform> params: Params;

fn carrier_bin(c: u32) -> u32 {
  let n = i32(params.fftSize);
  let bc = i32(c) + params.carrierBase;
  let m = bc % n;
  return u32((m + n) % n);
}

fn channel_at(c: u32, spPhase: u32, fftBase: u32) -> vec2<f32> {
  let first = 3u * spPhase;
  if (c <= first) {
    let b = fftBase + carrier_bin(first);
    return vec2<f32>(fftRe[b], fftIm[b]) * (1.0 / segRef[first]);
  }
  let pos = first + ((c - first) / 12u) * 12u;
  let b0 = fftBase + carrier_bin(pos);
  let h0 = vec2<f32>(fftRe[b0], fftIm[b0]) * (1.0 / segRef[pos]);
  if (c == pos) {
    return h0;
  }
  let nxt = pos + 12u;
  if (nxt >= params.cps) {
    return h0;
  }
  let b1 = fftBase + carrier_bin(nxt);
  let h1 = vec2<f32>(fftRe[b1], fftIm[b1]) * (1.0 / segRef[nxt]);
  return mix(h0, h1, f32(c - pos) / 12.0);
}

@compute @workgroup_size(64)
fn demap_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let s = gid.x;
  if (s >= params.count) {
    return;
  }
  let symIdx = symbolMeta[2u * s + 1u];
  let fftBase = s * params.fftSize;
  let spPhase = (symIdx + params.spOffset) % 4u;
  let tn = params.tmccCount;
  for (var j: u32 = 0u; j < tn; j = j + 1u) {
    let b = fftBase + carrier_bin(tmccCarriers[j]);
    tmccOut[(s * tn + j) * 2u] = fftRe[b];
    tmccOut[(s * tn + j) * 2u + 1u] = fftIm[b];
  }
  if (symIdx < params.frameStart || s < params.firstDecoded) {
    return;
  }
  let outBase = (s - params.firstDecoded) * params.dc;
  let idxBase = spPhase * params.dc;
  for (var k: u32 = 0u; k < params.dc; k = k + 1u) {
    let d = dataIdx[idxBase + k];
    let b = fftBase + carrier_bin(d);
    let y = vec2<f32>(fftRe[b], fftIm[b]);
    let h = channel_at(d, spPhase, fftBase);
    let den = h.x * h.x + h.y * h.y;
    let inv = select(0.0, 1.0 / den, den > 1e-12);
    out[outBase + k] = (y.x * h.x + y.y * h.y) * inv;
    out[params.count * params.dc + outBase + k] = (y.y * h.x - y.x * h.y) * inv;
  }
}
`

export const SYNC_WGSL = /* wgsl */ `
struct SyncParams {
  fftSize: u32,
  cpLength: u32,
  count: u32,
  start: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
  pad3: u32,
};

@group(0) @binding(0) var<storage, read> syncRe: array<f32>;
@group(0) @binding(1) var<storage, read> syncIm: array<f32>;
@group(0) @binding(2) var<storage, read_write> syncOut: array<f32>;
@group(0) @binding(3) var<uniform> syncParams: SyncParams;

// One invocation per candidate FFT-window start; writes [metric, gammaRe,
// gammaIm, phi]. Mirrors find_peak in wasm/dsp/src/ofdm.rs and
// src/dsp/stages/ofdmSync.ts.
@compute @workgroup_size(64)
fn sync_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let j = gid.x;
  if (j >= syncParams.count) {
    return;
  }
  let start = syncParams.start + j;
  let n = syncParams.fftSize;
  let l = syncParams.cpLength;
  var gr = 0.0;
  var gi = 0.0;
  var phi = 0.0;
  for (var i: u32 = 0u; i < l; i = i + 1u) {
    let a = start + i;
    let b = a + n;
    let ar = syncRe[a];
    let ai = syncIm[a];
    let br = syncRe[b];
    let bi = syncIm[b];
    gr = gr + (ar * br + ai * bi);
    gi = gi + (ai * br - ar * bi);
    phi = phi + 0.5 * (ar * ar + ai * ai);
    phi = phi + 0.5 * (br * br + bi * bi);
  }
  let metric = sqrt(gr * gr + gi * gi) - 0.5 * phi;
  syncOut[j * 4u] = metric;
  syncOut[j * 4u + 1u] = gr;
  syncOut[j * 4u + 2u] = gi;
  syncOut[j * 4u + 3u] = phi;
}
`
