import { describe, expect, it } from 'vitest'
import {
  AvcParameterSetCollector,
  buildAvcDecoderConfigurationRecord,
  codecStringFromParameterSets,
} from './avc'

const SPS = Uint8Array.from([0x67, 0x42, 0xc0, 0x1e, 0xdd])
const PPS = Uint8Array.from([0x68, 0xce, 0x0f, 0x2c, 0x80])
const AUD = Uint8Array.from([0x09, 0x10])
const IDR = Uint8Array.from([0x65, 0x88, 0x84])

describe('AvcParameterSetCollector', () => {
  it('retains the first SPS and PPS from an Annex-B access unit', () => {
    const collector = new AvcParameterSetCollector()
    const data = Uint8Array.from([
      0,
      0,
      1,
      ...AUD,
      0,
      0,
      0,
      1,
      ...SPS,
      0,
      0,
      1,
      ...PPS,
      0,
      0,
      1,
      ...IDR,
    ])
    expect(collector.push(data)).toBe(true)
    expect(collector.parameterSets?.sps).toEqual(SPS)
    expect(collector.parameterSets?.pps).toEqual(PPS)
  })

  it('accumulates parameter sets split across chunks', () => {
    const collector = new AvcParameterSetCollector()
    expect(collector.push(Uint8Array.from([0, 0, 1, ...SPS]))).toBe(false)
    expect(collector.push(Uint8Array.from([0, 0, 1, ...IDR]))).toBe(false)
    expect(collector.push(Uint8Array.from([0, 0, 1, ...PPS]))).toBe(true)
    expect(collector.complete).toBe(true)
  })

  it('ignores slice NAL units and clears on reset', () => {
    const collector = new AvcParameterSetCollector()
    expect(collector.push(Uint8Array.from([0, 0, 1, ...IDR]))).toBe(false)
    expect(collector.parameterSets).toBeNull()
    collector.reset()
    expect(collector.complete).toBe(false)
    expect(collector.push(Uint8Array.from([0, 0, 1, ...SPS, 0, 0, 1, ...PPS]))).toBe(true)
  })

  it('trims trailing zero padding before the next start code', () => {
    const collector = new AvcParameterSetCollector()
    collector.push(Uint8Array.from([0, 0, 1, ...SPS, 0x00, 0x00, 0, 0, 1, ...PPS]))
    expect(collector.parameterSets?.sps).toEqual(SPS)
  })
})

describe('buildAvcDecoderConfigurationRecord', () => {
  it('serializes an avcC record with one SPS and one PPS', () => {
    const record = buildAvcDecoderConfigurationRecord({ sps: SPS, pps: PPS })
    expect(Array.from(record)).toEqual([
      1,
      0x42,
      0xc0,
      0x1e,
      0xff,
      0xe1,
      0,
      SPS.length,
      ...SPS,
      1,
      0,
      PPS.length,
      ...PPS,
    ])
  })
})

describe('codecStringFromParameterSets', () => {
  it('derives an avc1.PPCCLL codec string from the SPS', () => {
    expect(codecStringFromParameterSets({ sps: SPS, pps: PPS })).toBe('avc1.42C01E')
  })
})
