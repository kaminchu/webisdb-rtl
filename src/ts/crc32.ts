const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i << 24
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0
    }
    table[i] = crc >>> 0
  }
  return table
})()

/** MPEG-2 CRC-32 (poly 0x04C11DB7, init 0xFFFFFFFF, no reflection, xorout 0). */
export function crc32(bytes: Uint8Array, start = 0, length = bytes.length - start): number {
  let crc = 0xffffffff
  const end = Math.min(start + length, bytes.length)
  for (let i = start; i < end; i++) {
    crc = (CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff] ^ (crc << 8)) >>> 0
  }
  return crc >>> 0
}

export function readCrc32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  )
}

export function verifySectionCrc(section: Uint8Array): boolean {
  if (section.length < 4) return false
  return crc32(section, 0, section.length - 4) === readCrc32(section, section.length - 4)
}
