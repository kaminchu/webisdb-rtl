import { describe, expect, it } from 'vitest'
import { CaptionRenderer, decodeCaptionPayload } from './caption'

const MANAGEMENT = 0
const STATEMENT = 1

function dataUnit(parameter: number, data: number[]): number[] {
  const size = data.length
  return [0x1f, parameter, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, ...data]
}

function statementData(statement: number[]): number[] {
  return statementUnits([dataUnit(0x20, statement)])
}

function withHeader(header: number[], units: number[][]): number[] {
  const length = units.reduce((total, unit) => total + unit.length, 0)
  return [...header, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff, ...units.flat()]
}

function statementUnits(units: number[][]): number[] {
  return withHeader([0x00], units)
}

function bcd(value: number): number {
  return ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff
}

/** Encode hour/minute/second/millisecond as the 36-bit BCD time used by STM/OTM. */
function timeBytes(hours: number, minutes: number, seconds: number, ms: number): number[] {
  const hundreds = Math.floor(ms / 100)
  const tens = Math.floor(ms / 10) % 10
  return [bcd(hours), bcd(minutes), bcd(seconds), bcd(hundreds * 10 + tens), bcd(ms % 10) << 4]
}

function timedStatement(tmd: number, time: number[], units: number[][]): number[] {
  return withHeader([tmd << 6, ...time], units)
}

function managementData(languages: string[], units: number[] = []): number[] {
  const body = [0x00, languages.length]
  for (const language of languages) {
    body.push(0x00, language.charCodeAt(0), language.charCodeAt(1), language.charCodeAt(2), 0x00)
  }
  const length = units.length
  body.push((length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff, ...units)
  return body
}

function managementWithOtm(otm: number[], languages: string[], units: number[] = []): number[] {
  const body = [0x80, ...otm, languages.length]
  for (const language of languages) {
    body.push(0x00, language.charCodeAt(0), language.charCodeAt(1), language.charCodeAt(2), 0x00)
  }
  const length = units.length
  body.push((length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff, ...units)
  return body
}

function dataGroup(id: number, body: number[]): number[] {
  const size = body.length
  return [(id << 2) & 0xfc, 0, 0, (size >> 8) & 0xff, size & 0xff, ...body, 0, 0]
}

function pes(...groups: number[][]): Uint8Array {
  return Uint8Array.from([0x80, 0xff, 0x00, ...groups.flat()])
}

const captionPes = (...units: number[][]) => pes(...units)

describe('decodeCaptionPayload', () => {
  it('decodes a statement in the data-group format', () => {
    const payload = captionPes(
      dataGroup(MANAGEMENT, managementData(['jpn'])),
      dataGroup(STATEMENT, statementData([0x0c, 0x87, 0x8a, 0xa4, 0xb3, 0xa4, 0xf3])),
    )
    const frame = decodeCaptionPayload(payload)
    expect(frame).not.toBeNull()
    expect(frame?.width).toBe(320)
    expect(frame?.height).toBe(180)
    expect(frame?.chars.map((char) => char.text).join('')).toBe('こん')
    expect(frame?.chars[0]).toMatchObject({ x: 0, y: 0 })
  })

  it('decodes ARIB additional symbols', () => {
    const payload = captionPes(dataGroup(STATEMENT, statementData([0x0c, 0xf5, 0xa1])))
    const frame = decodeCaptionPayload(payload)
    expect(frame?.chars[0].text).toBe('㐂')
  })

  it('applies foreground and background colours', () => {
    const payload = captionPes(
      dataGroup(STATEMENT, statementData([0x0c, 0x81, 0x90, 0x50, 0x00, 0xa4, 0xb3])),
    )
    const frame = decodeCaptionPayload(payload)
    expect(frame?.chars[0].foreground).toEqual({ r: 255, g: 0, b: 0, a: 255 })
    expect(frame?.chars[0].background).toEqual({ r: 0, g: 0, b: 0, a: 255 })
  })

  it('selects a CLUT palette', () => {
    const payload = captionPes(
      dataGroup(STATEMENT, statementData([0x0c, 0x90, 0x20, 0x01, 0x90, 0x40, 0xa4, 0xb3])),
    )
    const frame = decodeCaptionPayload(payload)
    expect(frame?.chars[0].foreground).toEqual({ r: 0, g: 0, b: 85, a: 255 })
  })

  it('positions characters with CSI and sets underline', () => {
    const payload = captionPes(
      dataGroup(
        STATEMENT,
        statementData([0x0c, 0x9a, 0x9b, 0x33, 0x3b, 0x32, 0x38, 0x61, 0xa4, 0xb3]),
      ),
    )
    const frame = decodeCaptionPayload(payload)
    expect(frame?.chars[0].x).toBe(3)
    expect(frame?.chars[0].y).toBe(4)
    expect(frame?.chars[0].underline).toBe(true)
  })

  it('returns a frame with no characters for a clear-screen statement', () => {
    const payload = captionPes(dataGroup(STATEMENT, statementData([0x0c])))
    expect(decodeCaptionPayload(payload)?.chars).toEqual([])
  })

  it('ignores management-only packets', () => {
    const payload = captionPes(dataGroup(MANAGEMENT, managementData(['jpn'])))
    expect(decodeCaptionPayload(payload)).toBeNull()
  })

  it('renders a DRCS character from its pattern data', () => {
    const drcs = [1, 0x41, 0x21, 1, 0x00, 0x00, 0x10, 0x12, ...Array<number>(36).fill(0xff)]
    const payload = captionPes(
      dataGroup(STATEMENT, statementUnits([dataUnit(0x30, drcs), dataUnit(0x20, [0x0c, 0x21])])),
    )
    const frame = decodeCaptionPayload(payload)
    expect(frame?.chars[0].drcs).toMatchObject({ width: 16, height: 18, bitsPerPixel: 1 })
  })

  it('falls back to a geta mark when the DRCS pattern is missing', () => {
    const payload = captionPes(dataGroup(STATEMENT, statementData([0x0c, 0x21])))
    expect(decodeCaptionPayload(payload)?.chars[0].text).toBe('\u3013')
  })

  it('applies a downloaded colour map to text colours', () => {
    const colorMap = [16, 128, 128, 255, 1]
    const payload = captionPes(
      dataGroup(MANAGEMENT, managementData(['jpn'], dataUnit(0x34, colorMap))),
      dataGroup(STATEMENT, statementData([0x0c, 0x81, 0xa4, 0xb3])),
    )
    expect(decodeCaptionPayload(payload)?.chars[0].foreground).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 255,
    })
  })

  it('exposes the colour map for multi-level DRCS colours', () => {
    const colorMap = [81, 90, 240, 255, 1, 41, 240, 110, 255]
    const drcs = [1, 0x41, 0x21, 1, 0x00, 0x02, 0x02, 0x01, 0x60]
    const payload = captionPes(
      dataGroup(MANAGEMENT, managementData(['jpn'], dataUnit(0x34, colorMap))),
      dataGroup(STATEMENT, statementUnits([dataUnit(0x30, drcs), dataUnit(0x20, [0x0c, 0x21])])),
    )
    const frame = decodeCaptionPayload(payload)
    expect(frame?.chars[0].drcs?.bitsPerPixel).toBe(2)
    expect(frame?.colorMap?.[1]?.r).toBeGreaterThan(240)
    expect(frame?.colorMap?.[1]?.g).toBeLessThan(10)
    expect(frame?.colorMap?.[1]?.b).toBeLessThan(10)
    expect(frame?.colorMap?.[2]?.b).toBeGreaterThan(240)
    expect(frame?.colorMap?.[2]?.r).toBeLessThan(10)
  })

  it('schedules an asynchronous statement from STM', () => {
    const now = Date.UTC(2020, 0, 1, 0, 0, 0)
    const payload = captionPes(
      dataGroup(STATEMENT, timedStatement(0b01, timeBytes(9, 0, 5, 0), [dataUnit(0x20, [0x0c])])),
    )
    const frame = decodeCaptionPayload(payload, null, () => now)
    expect(frame?.startWallMs).toBe(now + 5000)
    expect(frame?.startPts90k).toBeNull()
  })

  it('adds the OTM offset to the PES PTS in offset-time mode', () => {
    const otm = timeBytes(0, 0, 1, 500)
    const stm = timeBytes(9, 0, 0, 0)
    const payload = captionPes(
      dataGroup(MANAGEMENT, managementWithOtm(otm, ['jpn'])),
      dataGroup(STATEMENT, timedStatement(0b10, stm, [dataUnit(0x20, [0x0c])])),
    )
    expect(decodeCaptionPayload(payload, 9000)?.startPts90k).toBe(9000 + 1500 * 90)
  })
})

interface DrawCall {
  method: string
  fillStyle: string
}

function fakeContext(): { context: CanvasRenderingContext2D; calls: DrawCall[] } {
  const calls: DrawCall[] = []
  const state = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    lineJoin: 'round',
  }
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, fillStyle: state.fillStyle })
      void args
    }
  const context = {
    save: record('save'),
    restore: record('restore'),
    fillRect: record('fillRect'),
    fillText: record('fillText'),
    strokeText: record('strokeText'),
    beginPath: record('beginPath'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    stroke: record('stroke'),
  } as unknown as CanvasRenderingContext2D
  Object.defineProperties(context, {
    fillStyle: {
      get: () => state.fillStyle,
      set: (value: string) => {
        state.fillStyle = value
      },
    },
    strokeStyle: {
      get: () => state.strokeStyle,
      set: (value: string) => {
        state.strokeStyle = value
      },
    },
    lineWidth: {
      get: () => state.lineWidth,
      set: (value: number) => {
        state.lineWidth = value
      },
    },
    font: {
      get: () => state.font,
      set: (value: string) => {
        state.font = value
      },
    },
    textAlign: {
      get: () => state.textAlign,
      set: (value: string) => {
        state.textAlign = value
      },
    },
    textBaseline: {
      get: () => state.textBaseline,
      set: (value: string) => {
        state.textBaseline = value
      },
    },
    lineJoin: {
      get: () => state.lineJoin,
      set: (value: string) => {
        state.lineJoin = value
      },
    },
  })
  return { context, calls }
}

describe('CaptionRenderer', () => {
  it('stores the latest frame and clears on demand', () => {
    const renderer = new CaptionRenderer()
    const frame = decodeCaptionPayload(
      captionPes(dataGroup(STATEMENT, statementData([0x0c, 0x87, 0x8a, 0xa4, 0xb3]))),
    )
    renderer.set(frame)
    expect(renderer.current?.chars[0].text).toBe('こ')
    renderer.clear()
    expect(renderer.current).toBeNull()
  })

  it('keeps the previous frame when a payload has no statement', () => {
    const renderer = new CaptionRenderer()
    renderer.update(captionPes(dataGroup(STATEMENT, statementData([0x0c, 0xa4, 0xb3]))))
    const before = renderer.current
    renderer.update(captionPes(dataGroup(MANAGEMENT, managementData(['jpn']))))
    expect(renderer.current).toBe(before)
  })

  it('draws characters onto a scaled canvas', () => {
    const renderer = new CaptionRenderer()
    renderer.update(captionPes(dataGroup(STATEMENT, statementData([0x0c, 0xa4, 0xb3]))))
    const { context, calls } = fakeContext()
    renderer.draw(context, 640, 360)
    expect(calls.some((call) => call.method === 'fillText')).toBe(true)
  })

  it('schedules statements by PTS', () => {
    const renderer = new CaptionRenderer()
    const first = captionPes(dataGroup(STATEMENT, statementData([0x0c, 0xa4, 0xb3])))
    const second = captionPes(dataGroup(STATEMENT, statementData([0x0c, 0xa4, 0xc1])))
    const { context } = fakeContext()
    renderer.update(first, 100)
    expect(renderer.current).toBeNull()
    renderer.update(second, 200)
    renderer.draw(context, 320, 180, 120)
    expect(renderer.current?.chars[0].text).toBe('こ')
    renderer.draw(context, 320, 180, 220)
    expect(renderer.current?.chars[0].text).toBe('ち')
  })

  it('ignores a statement whose PTS is older than the active one', () => {
    const renderer = new CaptionRenderer()
    const current = captionPes(dataGroup(STATEMENT, statementData([0x0c, 0xa4, 0xc1])))
    const stale = captionPes(dataGroup(STATEMENT, statementData([0x0c, 0xa4, 0xb3])))
    const { context } = fakeContext()
    renderer.update(current, 200)
    renderer.draw(context, 320, 180, 200)
    renderer.update(stale, 100)
    renderer.draw(context, 320, 180, 300)
    expect(renderer.current?.chars[0].text).toBe('ち')
  })

  it('retains DRCS definitions across packets', () => {
    const renderer = new CaptionRenderer()
    const drcs = [1, 0x41, 0x21, 1, 0x00, 0x00, 0x10, 0x12, ...Array<number>(36).fill(0xff)]
    renderer.update(
      captionPes(dataGroup(MANAGEMENT, managementData(['jpn'], dataUnit(0x30, drcs)))),
    )
    renderer.update(captionPes(dataGroup(STATEMENT, statementData([0x0c, 0x21]))))
    expect(renderer.current?.chars[0].drcs).toMatchObject({ width: 16, height: 18 })
  })

  it('paints multi-level DRCS pixels with colour-map colours', () => {
    const renderer = new CaptionRenderer()
    const colorMap = [81, 90, 240, 255, 1, 41, 240, 110, 255]
    const drcs = [1, 0x41, 0x21, 1, 0x00, 0x02, 0x02, 0x01, 0x60]
    renderer.update(
      captionPes(dataGroup(MANAGEMENT, managementData(['jpn'], dataUnit(0x34, colorMap)))),
    )
    renderer.update(
      captionPes(
        dataGroup(STATEMENT, statementUnits([dataUnit(0x30, drcs), dataUnit(0x20, [0x0c, 0x21])])),
      ),
    )
    const { context, calls } = fakeContext()
    renderer.draw(context, 320, 180)
    const fills = calls.filter((call) => call.method === 'fillRect').map((call) => call.fillStyle)
    expect(fills.some((style) => /^rgba\(2[45]\d,0,0,/.test(style))).toBe(true)
    expect(fills.some((style) => style.startsWith('rgba(0,0,255,'))).toBe(true)
  })
})
