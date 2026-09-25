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
  LogoTransmission: 0xcf,
  DataComponent: 0xfd,
} as const

/** Parsed logo transmission descriptor (ARIB STD-B10 6.2.44). */
export interface LogoTransmission {
  /** logo_transmission_type. 0x01/0x02 reference CDT logo data; 0x03 is a simple logo. */
  transmissionType: number
  logoId?: number
  logoVersion?: number
  downloadDataId?: number
  /** Simple logo character string (transmission type 0x03). */
  text?: string
}
