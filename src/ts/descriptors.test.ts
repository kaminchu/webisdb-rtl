import { describe, expect, it } from 'vitest'
import {
  decodeAvcVideo,
  decodeContent,
  decodeDataComponent,
  decodeExtendedEvent,
  decodeLocalTimeOffset,
  decodeLogoTransmission,
  decodeNetworkName,
  decodeServiceDescriptor,
  decodeShortEvent,
  decodeStreamIdentifier,
  findDescriptor,
  parseDescriptors,
} from './descriptors'
import { asciiBytes, buildDescriptor, encodeAribText } from './sectionBuilder'

describe('parseDescriptors', () => {
  it('splits a descriptor loop', () => {
    const loop = Uint8Array.from([...buildDescriptor(0x40, [1, 2]), ...buildDescriptor(0x48, [3])])
    const descriptors = parseDescriptors(loop)
    expect(descriptors).toHaveLength(2)
    expect(descriptors[0].tag).toBe(0x40)
    expect(Array.from(descriptors[0].data)).toEqual([1, 2])
    expect(Array.from(descriptors[1].data)).toEqual([3])
    expect(findDescriptor(descriptors, 0x48)?.tag).toBe(0x48)
  })

  it('stops at a truncated descriptor', () => {
    const descriptors = parseDescriptors(Uint8Array.from([0x40, 0x05, 1, 2]))
    expect(descriptors).toHaveLength(0)
  })
})

describe('decoders', () => {
  it('decodes the service descriptor with ARIB text', () => {
    const provider = encodeAribText('ＮＨＫ')
    const name = encodeAribText('総合')
    const info = decodeServiceDescriptor(
      Uint8Array.from([0x01, provider.length, ...provider, name.length, ...name]),
    )
    expect(info.serviceType).toBe(0x01)
    expect(info.providerName).toBe('ＮＨＫ')
    expect(info.serviceName).toBe('総合')
  })

  it('decodes the network name descriptor', () => {
    expect(decodeNetworkName(encodeAribText('テスト'))).toBe('テスト')
  })

  it('decodes the logo transmission descriptor', () => {
    expect(decodeLogoTransmission(Uint8Array.from([0x03, ...encodeAribText('NST')]))).toEqual({
      transmissionType: 0x03,
      text: 'NST',
    })

    expect(
      decodeLogoTransmission(Uint8Array.from([0x01, 0xfe, 0x02, 0xf0, 0x02, 0x00, 0x02])),
    ).toEqual({ transmissionType: 0x01, logoId: 2, logoVersion: 2, downloadDataId: 2 })

    expect(decodeLogoTransmission(Uint8Array.from([0x02, 0xfe, 0x02]))).toEqual({
      transmissionType: 0x02,
      logoId: 2,
    })
  })

  it('decodes the short event descriptor', () => {
    const name = encodeAribText('こんにちは')
    const text = encodeAribText('hello')
    const info = decodeShortEvent(
      Uint8Array.from([...asciiBytes('jpn'), name.length, ...name, text.length, ...text]),
    )
    expect(info.language).toBe('jpn')
    expect(info.eventName).toBe('こんにちは')
    expect(info.text).toBe('hello')
  })

  it('decodes the extended event descriptor', () => {
    const description = encodeAribText('cast')
    const itemText = encodeAribText('NHK')
    const mainText = encodeAribText('テスト')
    const items = [description.length, ...description, itemText.length, ...itemText]
    const info = decodeExtendedEvent(
      Uint8Array.from([
        0x00,
        ...asciiBytes('jpn'),
        items.length,
        ...items,
        mainText.length,
        ...mainText,
      ]),
    )
    expect(info.language).toBe('jpn')
    expect(info.items).toHaveLength(1)
    expect(info.items[0].description).toBe('cast')
    expect(info.items[0].text).toBe('NHK')
    expect(info.text).toBe('テスト')
  })

  it('decodes content genres', () => {
    const genres = decodeContent(Uint8Array.from([0x70, 0x00, 0x10, 0x01]))
    expect(genres).toEqual([0x70, 0x10])
  })

  it('decodes local time offset entries', () => {
    const data = Uint8Array.from([
      0x4a, 0x50, 0x4e, 0x02, 0x09, 0x00, 0x40, 0x58, 0x41, 0x00, 0x00, 0x09, 0x00,
    ])
    const [entry] = decodeLocalTimeOffset(data)
    expect(entry.countryCode).toBe('JPN')
    expect(entry.polarity).toBe(0)
    expect(entry.offsetMinutes).toBe(540)
    expect(entry.nextOffsetMinutes).toBe(540)
    expect(entry.changeTime).toBeInstanceOf(Date)
  })

  it('decodes AVC video configuration', () => {
    expect(decodeAvcVideo(Uint8Array.from([1, 0x64, 0x00, 0x28]))).toEqual({
      configurationVersion: 1,
      avcProfileIndication: 0x64,
      profileCompatibility: 0x00,
      avcLevelIndication: 0x28,
      description: Uint8Array.from([1, 0x64, 0x00, 0x28]),
    })
  })

  it('decodes data component and stream identifier descriptors', () => {
    const component = decodeDataComponent(Uint8Array.from([0x00, 0x08, 0x01]))
    expect(component.dataComponentId).toBe(0x0008)
    expect(Array.from(component.data)).toEqual([0x01])
    expect(decodeStreamIdentifier(Uint8Array.from([0x42]))).toBe(0x42)
  })
})
