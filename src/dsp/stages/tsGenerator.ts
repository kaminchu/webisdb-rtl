/**
 * MPEG-TS packet assembly from Reed-Solomon output.
 *
 * After RS decoding each 188-byte block is one transport packet. Depending on
 * the RS input ordering the sync byte (0x47) may sit at the front or the back
 * of the block, so the generator normalises it to the front and validates it.
 * Bytes are accumulated and handed out as a continuous stream.
 */

import { RS_CODEWORD_SIZE, SYNC_BYTE, TS_PACKET_SIZE } from './energyDispersal'

export interface TsStats {
  packets: number
  syncErrors: number
}

export class TsGenerator {
  private pending: number[] = []
  private readonly counters: TsStats = { packets: 0, syncErrors: 0 }

  get stats(): TsStats {
    return this.counters
  }

  /** Accept a 188-byte packet or a 204-byte RS codeword (parity ignored). */
  pushBlock(block: Uint8Array): void {
    let packet: Uint8Array
    if (block.length === RS_CODEWORD_SIZE) {
      packet = block.subarray(0, TS_PACKET_SIZE)
    } else if (block.length === TS_PACKET_SIZE) {
      packet = block
    } else {
      throw new Error(`TS block must be ${TS_PACKET_SIZE} or ${RS_CODEWORD_SIZE} bytes`)
    }

    if (packet[0] !== SYNC_BYTE) {
      if (packet[TS_PACKET_SIZE - 1] === SYNC_BYTE) {
        const rotated = new Uint8Array(TS_PACKET_SIZE)
        rotated[0] = SYNC_BYTE
        rotated.set(packet.subarray(0, TS_PACKET_SIZE - 1), 1)
        packet = rotated
      } else {
        this.counters.syncErrors++
      }
    }

    this.counters.packets++
    for (let i = 0; i < packet.length; i++) this.pending.push(packet[i])
  }

  /** Return and clear all buffered bytes. */
  takeBytes(): Uint8Array {
    const out = Uint8Array.from(this.pending)
    this.pending = []
    return out
  }

  reset(): void {
    this.pending = []
    this.counters.packets = 0
    this.counters.syncErrors = 0
  }
}
