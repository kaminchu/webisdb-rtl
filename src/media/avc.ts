const NAL_TYPE_SPS = 7
const NAL_TYPE_PPS = 8

export interface AvcParameterSets {
  sps: Uint8Array
  pps: Uint8Array
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0').toUpperCase()
}

/**
 * Collects the first SPS/PPS pair from an Annex-B AVC elementary stream.
 *
 * WebCodecs requires an `AVCDecoderConfigurationRecord` (avcC) `description` to
 * use the `avc` bitstream format. Hardware decoders on Android reject Annex-B
 * chunks without it, so the player rebuilds the record from the in-band
 * parameter sets that ISDB-T one-seg repeats before each IDR.
 */
export class AvcParameterSetCollector {
  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null

  get complete(): boolean {
    return this.sps !== null && this.pps !== null
  }

  get parameterSets(): AvcParameterSets | null {
    const { sps, pps } = this
    return sps && pps ? { sps, pps } : null
  }

  reset(): void {
    this.sps = null
    this.pps = null
  }

  /** Scan one Annex-B chunk, retaining the first SPS and PPS. Returns completion. */
  push(data: Uint8Array): boolean {
    const starts: number[] = []
    let i = 0
    while (i + 3 <= data.length) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        starts.push(i)
        i += 3
      } else {
        i++
      }
    }
    for (let s = 0; s < starts.length; s++) {
      const begin = starts[s] + 3
      let end = s + 1 < starts.length ? starts[s + 1] : data.length
      while (end > begin && data[end - 1] === 0) end--
      if (end <= begin) continue
      const type = data[begin] & 0x1f
      if (type === NAL_TYPE_SPS && !this.sps) this.sps = data.slice(begin, end)
      else if (type === NAL_TYPE_PPS && !this.pps) this.pps = data.slice(begin, end)
    }
    return this.complete
  }
}

/** Build an ISO/IEC 14496-15 AVCDecoderConfigurationRecord from SPS and PPS. */
export function buildAvcDecoderConfigurationRecord(sets: AvcParameterSets): Uint8Array {
  const { sps, pps } = sets
  const record = new Uint8Array(11 + sps.length + pps.length)
  record[0] = 1
  record[1] = sps[1]
  record[2] = sps[2]
  record[3] = sps[3]
  record[4] = 0xff
  record[5] = 0xe1
  record[6] = (sps.length >> 8) & 0xff
  record[7] = sps.length & 0xff
  record.set(sps, 8)
  const offset = 8 + sps.length
  record[offset] = 1
  record[offset + 1] = (pps.length >> 8) & 0xff
  record[offset + 2] = pps.length & 0xff
  record.set(pps, offset + 3)
  return record
}

/** Derive the RFC 6381 `avc1.PPCCLL` codec string from an SPS NAL unit. */
export function codecStringFromParameterSets(sets: AvcParameterSets): string {
  const { sps } = sets
  return `avc1.${hexByte(sps[1])}${hexByte(sps[2])}${hexByte(sps[3])}`
}
