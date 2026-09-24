import { describe, expect, it } from 'vitest'
import { MockUsbTransport, type RecordedTransfer } from './usbTransport'
import { Rtl2832u, RTL_FIR_COEFFICIENTS, isValidSampleRate } from './rtl2832u'

interface DemodWrite {
  page: number
  addr: number
  data: Uint8Array
}

function demodWrites(mock: MockUsbTransport): DemodWrite[] {
  return mock.transfers
    .filter((t) => t.type === 'controlOut' && (t.value & 0x20) !== 0)
    .map((t) => ({ page: t.index & 0x0f, addr: t.value >> 8, data: t.data ?? new Uint8Array() }))
}

function commitReads(mock: MockUsbTransport): RecordedTransfer[] {
  return mock.transfers.filter(
    (t) => t.type === 'controlIn' && t.index === 0x0a && t.value === 0x120,
  )
}

describe('Rtl2832u.initBaseband', () => {
  it('writes the USB/SYS power-on registers', async () => {
    const mock = new MockUsbTransport()
    await new Rtl2832u(mock).initBaseband()

    const blockWrites = mock.transfers.filter((t) => t.type === 'controlOut' && t.index >= 0x100)
    const byAddr = new Map(blockWrites.map((t) => [t.value, t]))
    expect(byAddr.get(0x2000)?.data).toEqual(Uint8Array.of(0x09))
    expect(byAddr.get(0x2158)?.data).toEqual(Uint8Array.of(0x00, 0x02))
    expect(byAddr.get(0x2148)?.data).toEqual(Uint8Array.of(0x10, 0x02))
    expect(byAddr.get(0x300b)?.data).toEqual(Uint8Array.of(0x22))
    expect(byAddr.get(0x3000)?.data).toEqual(Uint8Array.of(0xe8))
  })

  it('uploads the 20-byte FIR and commits every demod write', async () => {
    const mock = new MockUsbTransport()
    await new Rtl2832u(mock).initBaseband()

    const writes = demodWrites(mock)
    expect(writes).toHaveLength(35)

    const fir = writes.filter((w) => w.page === 1 && w.addr >= 0x1c && w.addr <= 0x2f)
    expect(fir).toHaveLength(20)
    expect(Uint8Array.from(fir.map((w) => w.data[0]))).toEqual(RTL_FIR_COEFFICIENTS)

    expect(commitReads(mock)).toHaveLength(writes.length)
  })

  it('resets the demod and clears the DDC shift/IF registers', async () => {
    const mock = new MockUsbTransport()
    await new Rtl2832u(mock).initBaseband()
    const writes = demodWrites(mock)

    expect(writes[0]).toMatchObject({ page: 1, addr: 0x01 })
    expect(writes[0].data).toEqual(Uint8Array.of(0x14))
    expect(writes[1].data).toEqual(Uint8Array.of(0x10))
    expect(writes[2]).toMatchObject({ page: 1, addr: 0x15 })
    expect(writes[3]).toMatchObject({ page: 1, addr: 0x16 })
    expect(writes[4]).toMatchObject({ page: 1, addr: 0x18 })
    expect(writes[5]).toMatchObject({ page: 1, addr: 0x1a })
  })
})

describe('Rtl2832u.setSampleRate', () => {
  it('computes and writes the resampling ratio for 1.2 MSps', async () => {
    const mock = new MockUsbTransport()
    await new Rtl2832u(mock).setSampleRate(1_200_000)

    const writes = demodWrites(mock)
    const at = (addr: number) => writes.find((w) => w.page === 1 && w.addr === addr)
    expect(at(0x9f)?.data).toEqual(Uint8Array.of(0x06, 0x00))
    expect(at(0xa1)?.data).toEqual(Uint8Array.of(0x00, 0x00))
    expect(at(0x3f)?.data).toEqual(Uint8Array.of(0x00))
    expect(at(0x3e)?.data).toEqual(Uint8Array.of(0x00))
    expect(writes.at(-2)?.data).toEqual(Uint8Array.of(0x14))
    expect(writes.at(-1)?.data).toEqual(Uint8Array.of(0x10))
  })

  it('rejects sample rates outside the supported ranges', () => {
    expect(isValidSampleRate(225000)).toBe(false)
    expect(isValidSampleRate(500000)).toBe(false)
    expect(isValidSampleRate(3_200_001)).toBe(false)
    expect(isValidSampleRate(1_200_000)).toBe(true)
    expect(isValidSampleRate(2_400_000)).toBe(true)
  })

  it('throws for an invalid sample rate', async () => {
    const mock = new MockUsbTransport()
    await expect(new Rtl2832u(mock).setSampleRate(500000)).rejects.toThrow(RangeError)
  })
})

describe('Rtl2832u.setIfFreq', () => {
  it('writes the signed 24-bit IF offset for 3.57 MHz', async () => {
    const mock = new MockUsbTransport()
    await new Rtl2832u(mock).setIfFreq(3_570_000)
    const writes = demodWrites(mock)
    const values = writes.map((w) => w.data[0])
    expect(writes.map((w) => w.addr)).toEqual([0x19, 0x1a, 0x1b])
    expect(values[0] & 0x3f).toBe(0x38)
  })
})
