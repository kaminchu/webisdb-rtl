import type { PatProgram, PatSection } from '../../models/si'

export function decodePat(section: Uint8Array): PatSection {
  const transportStreamId = (section[3] << 8) | section[4]
  const version = (section[5] >> 1) & 0x1f
  const end = section.length - 4

  const programs: PatProgram[] = []
  let networkPid = 0x0010
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    const programNumber = (section[offset] << 8) | section[offset + 1]
    const pid = ((section[offset + 2] & 0x1f) << 8) | section[offset + 3]
    if (programNumber === 0) networkPid = pid
    else programs.push({ programNumber, pid })
  }

  return { transportStreamId, version, programs, networkPid }
}
