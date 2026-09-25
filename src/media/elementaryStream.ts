const SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

/** A valid AAC frame is far smaller; drop garbage that never resynchronises. */
const MAX_PENDING_BYTES = 8192

export interface AdtsFrame {
  data: Uint8Array
  timestamp: number
  sampleRate: number
  numberOfChannels: number
  codec: string
}

export class AdtsAssembler {
  private pending = new Uint8Array(0)
  private timestamp = 0

  reset(): void {
    this.pending = new Uint8Array(0)
    this.timestamp = 0
  }

  push(data: Uint8Array, ptsUs: number): AdtsFrame[] {
    const carried = this.pending.length
    const bytes = new Uint8Array(carried + data.length)
    bytes.set(this.pending)
    bytes.set(data, carried)
    const frames: AdtsFrame[] = []
    let offset = 0
    let anchored = false
    while (offset + 7 <= bytes.length) {
      if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xf6) !== 0xf0) {
        offset++
        continue
      }
      const sampleRate = SAMPLE_RATES[(bytes[offset + 2] >> 2) & 15]
      const channels = ((bytes[offset + 2] & 1) << 2) | (bytes[offset + 3] >> 6)
      const length =
        ((bytes[offset + 3] & 3) << 11) | (bytes[offset + 4] << 3) | (bytes[offset + 5] >> 5)
      const headerLength = (bytes[offset + 1] & 1) !== 0 ? 7 : 9
      if (!sampleRate || !channels || length < headerLength) {
        offset++
        continue
      }
      if (offset >= carried && !anchored) {
        this.timestamp = ptsUs
        anchored = true
      }
      if (offset + length > bytes.length) break
      frames.push({
        data: bytes.slice(offset, offset + length),
        timestamp: this.timestamp,
        sampleRate,
        numberOfChannels: channels,
        codec: `mp4a.40.${(bytes[offset + 2] >> 6) + 1}`,
      })
      this.timestamp += (1024 * ((bytes[offset + 6] & 3) + 1) * 1_000_000) / sampleRate
      offset += length
    }
    this.pending =
      bytes.length - offset > MAX_PENDING_BYTES ? new Uint8Array(0) : bytes.slice(offset)
    return frames
  }
}

/** ARIB STD-B32 AVC streams delimit access units with AUD NAL units. */
export function splitAvcAccessUnits(data: Uint8Array): Uint8Array[] {
  const starts: number[] = []
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 31) === 9) {
      starts.push(i > 0 && data[i - 1] === 0 ? i - 1 : i)
    }
  }
  if (starts.length < 2) return [data]
  starts[0] = 0
  return starts.map((start, index) => data.subarray(start, starts[index + 1] ?? data.length))
}
