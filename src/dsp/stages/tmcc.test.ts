import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MODE_PARAMS, ONESEG_SAMPLING_HZ, oneSegTmccCarriers } from '../isdbtParams'
import { u8ToComplex } from '../carrier'
import { TsFftBackend } from './fft'
import { extractOneSegCarriers } from '../carrier'
import { OfdmSynchronizer } from './ofdmSync'
import { NcoCorrector } from './frequencyCorrection'
import { DcRemoval } from './dcRemoval'
import { TmccDecoder, decodeTmccBits, dscSyndromeCount, matchSyncWord } from './tmcc'

const SYNC_EVEN = [0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0]

function makeFrame(): Uint8Array {
  return Uint8Array.from(
    '001101011110111000000111101001001011000101101001011001111111111111100100101100010110100101100111111111111111111111111111100101011111010000001100111001111101011100111001011011011101010001111100010100101100',
    Number,
  )
}

describe('matchSyncWord', () => {
  it('recognises the even and odd words', () => {
    const even = makeFrame()
    expect(matchSyncWord(even)).toBe(1)
    const odd = new Uint8Array(204)
    for (let i = 0; i < 16; i++) odd[i] = SYNC_EVEN[i] ^ 1
    expect(matchSyncWord(odd)).toBe(2)
    const junk = new Uint8Array(16)
    junk[0] = 1
    expect(matchSyncWord(junk)).toBe(0)
  })
})

describe('dscSyndromeCount', () => {
  it('accepts the all-zero codeword and rejects a single bit', () => {
    expect(dscSyndromeCount(new Uint8Array(184))).toBe(0)
    const bad = new Uint8Array(184)
    bad[50] = 1
    expect(dscSyndromeCount(bad)).toBeGreaterThan(0)
  })
})

describe('decodeTmccBits', () => {
  it('extracts mode and layer fields', () => {
    const info = decodeTmccBits(makeFrame(), 3, 8)
    expect(info.mode).toBe(3)
    expect(info.guardIntervalRatio).toBe(8)
    expect(info.systemDescriptor).toBe(0)
    expect(info.partialReception).toBe(true)
    expect(info.layers.A).toEqual({ modulation: 1, codeRate: 1, timeInterleave: 3, segments: 1 })
    expect(info.locked).toBe(true)
  })
})

function encodeDbpsk(
  frameBits: Uint8Array,
  producedBits: number,
): { re: Float32Array; im: Float32Array } {
  const count = producedBits + 1
  const re = new Float32Array(count)
  const im = new Float32Array(count)
  let phase = 0
  re[0] = 1
  for (let i = 0; i < producedBits; i++) {
    if (frameBits[i % frameBits.length] === 1) phase += Math.PI
    re[i + 1] = Math.cos(phase)
    im[i + 1] = Math.sin(phase)
  }
  return { re, im }
}

describe('TmccDecoder', () => {
  it('rejects repeated consistent fields with invalid DSC parity', () => {
    const frame = makeFrame()
    frame[125] ^= 1
    const stream = encodeDbpsk(frame, 1020)
    const decoder = new TmccDecoder(1, 8)
    let info
    for (let i = 0; i < stream.re.length; i++)
      info = decoder.push(stream.re.subarray(i, i + 1), stream.im.subarray(i, i + 1))
    expect(info?.locked).toBe(false)
  })

  it('keeps lock across alternating frame sync words', () => {
    const even = makeFrame()
    const odd = even.slice()
    for (let i = 0; i < 16; i++) odd[i] ^= 1
    const pair = Uint8Array.from([...even, ...odd])
    const stream = encodeDbpsk(pair, 2040)
    const decoder = new TmccDecoder(1, 8)
    let info
    for (let i = 0; i < stream.re.length; i++)
      info = decoder.push(stream.re.subarray(i, i + 1), stream.im.subarray(i, i + 1))
    expect(info?.locked).toBe(true)
    expect(info?.frameCount).toBeGreaterThanOrEqual(9)
  })
  it('locks after two consistent majority frames', () => {
    const frame = makeFrame()
    const stream = encodeDbpsk(frame, 612)
    const decoder = new TmccDecoder(1, 8)
    let info = decoder.push(stream.re.subarray(0, 1), stream.im.subarray(0, 1))
    for (let i = 1; i <= 204; i++) {
      info = decoder.push(stream.re.subarray(i, i + 1), stream.im.subarray(i, i + 1))
    }
    expect(info.locked).toBe(false)
    for (let i = 205; i <= 612; i++) {
      info = decoder.push(stream.re.subarray(i, i + 1), stream.im.subarray(i, i + 1))
    }
    expect(info.locked).toBe(true)
    expect(info.mode).toBe(1)
    expect(info.layers.A?.segments).toBe(1)
  })
})

const iqPath = '/tmp/opencode/iq/all19.iq'
const hasIq = existsSync(iqPath)

describe.skipIf(!hasIq)('real IQ smoke (not an assertion)', () => {
  it('reports whether a TMCC lock is reached', () => {
    const raw = readFileSync(iqPath)
    const interleaved = u8ToComplex(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
    const srcLen = Math.floor(interleaved.length / 2)
    const srcRe = new Float32Array(srcLen)
    const srcIm = new Float32Array(srcLen)
    for (let i = 0; i < srcLen; i++) {
      srcRe[i] = interleaved[2 * i]
      srcIm[i] = interleaved[2 * i + 1]
    }

    const ratio = ONESEG_SAMPLING_HZ / 1_200_000
    const outLen = Math.floor(srcLen * ratio)
    const re = new Float32Array(outLen)
    const im = new Float32Array(outLen)
    const invRatio = 1 / ratio
    for (let i = 0; i < outLen; i++) {
      const pos = i * invRatio
      const i0 = Math.floor(pos)
      const i1 = Math.min(i0 + 1, srcLen - 1)
      const t = pos - i0
      re[i] = srcRe[i0] * (1 - t) + srcRe[i1] * t
      im[i] = srcIm[i0] * (1 - t) + srcIm[i1] * t
    }
    const dc = new DcRemoval(0.001)
    dc.process(re, im)

    const backend = new TsFftBackend()
    let lockedMode = 0
    let lockedGi = -1
    let lockedShift = 0
    const diag: string[] = []
    for (const mode of [3, 2, 1] as const) {
      const n = MODE_PARAMS[mode].oneSegFftSize
      for (const gi of [4, 8, 16, 32]) {
        const sync = new OfdmSynchronizer(n, gi, ONESEG_SAMPLING_HZ)
        const syncOut = sync.process(re, im)
        diag.push(
          `m${mode}/gi${gi}:sym=${syncOut.symbolStarts.length},metric=${syncOut.metric.toFixed(2)}`,
        )
        if (syncOut.symbolStarts.length < 220) continue
        const correctedRe = re.slice()
        const correctedIm = im.slice()
        if (syncOut.fractionalOffsetHz !== null) {
          const nco = new NcoCorrector(syncOut.fractionalOffsetHz, ONESEG_SAMPLING_HZ)
          nco.process(correctedRe, correctedIm)
        }
        const tmccCarriers = oneSegTmccCarriers(mode)
        for (let shift = -4; shift <= 4; shift++) {
          const decoder = new TmccDecoder(mode)
          let info = decoder.push(new Float32Array(1), new Float32Array(1))
          const fRe = new Float32Array(n)
          const fIm = new Float32Array(n)
          for (const start of syncOut.symbolStarts) {
            if (start + n > correctedRe.length) break
            fRe.set(correctedRe.subarray(start, start + n))
            fIm.set(correctedIm.subarray(start, start + n))
            backend.forward(fRe, fIm)
            const carriers = extractOneSegCarriers(fRe, fIm, mode)
            const tr = new Float32Array(tmccCarriers.length)
            const ti = new Float32Array(tmccCarriers.length)
            for (let c = 0; c < tmccCarriers.length; c++) {
              const k = Math.min(Math.max(tmccCarriers[c] + shift, 0), carriers.re.length - 1)
              tr[c] = carriers.re[k]
              ti[c] = carriers.im[k]
            }
            info = decoder.push(tr, ti)
          }
          if (info.locked) {
            lockedMode = mode
            lockedGi = gi
            lockedShift = shift
            break
          }
        }
        if (lockedGi >= 0) break
      }
      if (lockedGi >= 0) break
    }
    console.log(
      `[real IQ smoke] file=${iqPath} samples=${outLen} locked=${lockedGi >= 0} mode=${lockedMode} gi=${lockedGi} shift=${lockedShift}`,
    )
    console.log(`[real IQ smoke] ${diag.join(' | ')}`)
    expect(true).toBe(true)
  }, 30_000)
})
