/**
 * Minimal WebUSB abstraction for the RTL-SDR driver (要件定義書 11).
 *
 * `UsbTransport` decouples the register/IO layer from WebUSB so the driver can be
 * exercised in unit tests with `MockUsbTransport` and without a physical dongle.
 */

export const RTL_SDR_VENDOR_ID = 0x0bda

export interface UsbControlSetup {
  requestType: 'standard' | 'class' | 'vendor'
  recipient: 'device' | 'interface' | 'endpoint' | 'other'
  request: number
  value: number
  index: number
}

export interface UsbInTransferResult {
  status: 'ok' | 'stall' | 'babble'
  data?: DataView
}

export interface UsbOutTransferResult {
  status: 'ok' | 'stall'
  bytesWritten: number
}

/** Structural subset of the WebUSB `USBDevice` interface we rely on. */
export interface WebUsbDevice {
  readonly vendorId: number
  readonly productId: number
  readonly opened: boolean
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(configurationValue: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface(interfaceNumber: number): Promise<void>
  reset(): Promise<void>
  controlTransferIn(setup: UsbControlSetup, length: number): Promise<UsbInTransferResult>
  controlTransferOut(setup: UsbControlSetup, data?: Uint8Array): Promise<UsbOutTransferResult>
  transferIn(endpointNumber: number, length: number): Promise<UsbInTransferResult>
}

export interface WebUsbApi {
  addEventListener(type: 'disconnect', listener: (event: { device: WebUsbDevice }) => void): void
  removeEventListener(type: 'disconnect', listener: (event: { device: WebUsbDevice }) => void): void
  getDevices(): Promise<WebUsbDevice[]>
  requestDevice(options: {
    filters: Array<{ vendorId?: number; productId?: number; classCode?: number }>
  }): Promise<WebUsbDevice>
}

export interface UsbTransport {
  readonly vendorId: number
  readonly productId: number
  readonly isOpen: boolean
  open(): Promise<void>
  close(): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface(interfaceNumber: number): Promise<void>
  /** Vendor control IN; `request` is always 0 for the RTL2832U. */
  controlIn(request: number, value: number, index: number, length: number): Promise<Uint8Array>
  /** Vendor control OUT; `request` is always 0 for the RTL2832U. */
  controlOut(request: number, value: number, index: number, data?: Uint8Array): Promise<void>
  bulkIn(endpoint: number, length: number): Promise<Uint8Array>
  reset(): Promise<void>
  onDisconnect(cb: () => void): () => void
}

function getWebUsb(): WebUsbApi {
  const nav = globalThis.navigator as Navigator & { usb?: WebUsbApi }
  if (!nav.usb) throw new Error('WebUSB is not available in this browser')
  return nav.usb
}

export async function requestRtlSdrDevice(): Promise<WebUsbTransport> {
  const usb = getWebUsb()
  const device = await usb.requestDevice({ filters: [{ vendorId: RTL_SDR_VENDOR_ID }] })
  return new WebUsbTransport(device)
}

function toBytes(result: UsbInTransferResult): Uint8Array {
  if (result.status !== 'ok') throw new Error(`USB transfer failed: ${result.status}`)
  const view = result.data
  if (!view) return new Uint8Array(0)
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
}

export class WebUsbTransport implements UsbTransport {
  private readonly device: WebUsbDevice
  private readonly claimedInterfaces = new Set<number>()

  constructor(device: WebUsbDevice) {
    this.device = device
  }

  get vendorId(): number {
    return this.device.vendorId
  }

  get productId(): number {
    return this.device.productId
  }

  get isOpen(): boolean {
    return this.device.opened
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open()
    await this.device.selectConfiguration(1)
  }

  async close(): Promise<void> {
    this.claimedInterfaces.clear()
    if (this.device.opened) await this.device.close()
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    if (this.claimedInterfaces.has(interfaceNumber)) return
    await this.device.claimInterface(interfaceNumber)
    this.claimedInterfaces.add(interfaceNumber)
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    if (!this.claimedInterfaces.delete(interfaceNumber)) return
    await this.device.releaseInterface(interfaceNumber)
  }

  async controlIn(
    request: number,
    value: number,
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    const result = await this.device.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request, value, index },
      length,
    )
    return toBytes(result)
  }

  async controlOut(
    request: number,
    value: number,
    index: number,
    data?: Uint8Array,
  ): Promise<void> {
    const result = await this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request, value, index },
      data,
    )
    if (result.status !== 'ok') throw new Error(`USB control out failed: ${result.status}`)
  }

  async bulkIn(endpoint: number, length: number): Promise<Uint8Array> {
    // WebUSB takes the endpoint number; direction is supplied by transferIn.
    return toBytes(await this.device.transferIn(endpoint & 0x0f, length))
  }

  async reset(): Promise<void> {
    await this.device.reset()
  }

  onDisconnect(cb: () => void): () => void {
    const usb = getWebUsb()
    const listener = (event: { device: WebUsbDevice }): void => {
      if (event.device === this.device) cb()
    }
    usb.addEventListener('disconnect', listener)
    return () => usb.removeEventListener('disconnect', listener)
  }
}

export interface RecordedTransfer {
  type: 'controlIn' | 'controlOut' | 'bulkIn'
  request: number
  value: number
  index: number
  length: number
  endpoint?: number
  data?: Uint8Array
}

/**
 * Programmable transport used by unit tests. Records every transfer and lets tests
 * script control IN responses and queue bulk IN buffers.
 */
export class MockUsbTransport implements UsbTransport {
  vendorId = RTL_SDR_VENDOR_ID
  productId = 0x2838
  isOpen = false
  claimed: number[] = []
  transfers: RecordedTransfer[] = []
  controlInHandler: (request: number, value: number, index: number, length: number) => Uint8Array =
    (_request, _value, _index, length) => new Uint8Array(length)

  private bulkQueue: Uint8Array[] = []
  private pendingBulk: ((data: Uint8Array) => void) | null = null
  private readonly disconnectHandlers = new Set<() => void>()

  async open(): Promise<void> {
    this.isOpen = true
  }

  async close(): Promise<void> {
    this.isOpen = false
    this.releasePendingBulk()
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    this.claimed.push(interfaceNumber)
  }

  async releaseInterface(): Promise<void> {}

  async reset(): Promise<void> {}

  async controlIn(
    request: number,
    value: number,
    index: number,
    length: number,
  ): Promise<Uint8Array> {
    this.transfers.push({ type: 'controlIn', request, value, index, length })
    return this.controlInHandler(request, value, index, length)
  }

  async controlOut(
    request: number,
    value: number,
    index: number,
    data?: Uint8Array,
  ): Promise<void> {
    this.transfers.push({
      type: 'controlOut',
      request,
      value,
      index,
      length: data?.length ?? 0,
      data: data ? data.slice() : undefined,
    })
  }

  async bulkIn(endpoint: number, length: number): Promise<Uint8Array> {
    this.transfers.push({ type: 'bulkIn', request: 0, value: 0, index: 0, length, endpoint })
    const queued = this.bulkQueue.shift()
    if (queued) return queued
    return new Promise<Uint8Array>((resolve) => {
      this.pendingBulk = resolve
    })
  }

  pushBulk(data: Uint8Array): void {
    if (this.pendingBulk) {
      const resolve = this.pendingBulk
      this.pendingBulk = null
      resolve(data)
      return
    }
    this.bulkQueue.push(data)
  }

  releasePendingBulk(): void {
    if (!this.pendingBulk) return
    const resolve = this.pendingBulk
    this.pendingBulk = null
    resolve(new Uint8Array(0))
  }

  onDisconnect(cb: () => void): () => void {
    this.disconnectHandlers.add(cb)
    return () => this.disconnectHandlers.delete(cb)
  }

  emitDisconnect(): void {
    for (const cb of this.disconnectHandlers) cb()
  }
}
