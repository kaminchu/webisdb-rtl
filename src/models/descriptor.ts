/** Generic PSI/SI descriptor as parsed from a section. */
export interface Descriptor {
  tag: number
  data: Uint8Array
}

export const DescriptorTag = {
  NetworkName: 0x40,
  ServiceList: 0x41,
  ServiceDescriptor: 0x48,
  ShortEvent: 0x4d,
  ExtendedEvent: 0x4e,
  ContentDescriptor: 0x54,
  LocalTimeOffset: 0x58,
  StreamIdentifier: 0x52,
  ParentalRating: 0x55,
  DataComponent: 0xfd,
} as const
