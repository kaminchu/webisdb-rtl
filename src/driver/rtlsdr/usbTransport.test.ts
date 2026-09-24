import { afterEach, describe, expect, it, vi } from 'vitest'
import { RTL_BULK_ENDPOINT } from './rtl2832u'
import { WebUsbTransport, type WebUsbDevice } from './usbTransport'

describe('WebUsbTransport bulk input', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('listens for device disconnection on navigator.usb rather than USBDevice', () => {
    const usb = new EventTarget()
    vi.stubGlobal('navigator', { usb })
    const device = {} as WebUsbDevice
    const onDisconnect = vi.fn()
    const unsubscribe = new WebUsbTransport(device).onDisconnect(onDisconnect)
    const disconnect = (target: WebUsbDevice) =>
      usb.dispatchEvent(Object.assign(new Event('disconnect'), { device: target }))
    disconnect({} as WebUsbDevice)
    expect(onDisconnect).not.toHaveBeenCalled()
    disconnect(device)
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    unsubscribe()
    disconnect(device)
    expect(onDisconnect).toHaveBeenCalledTimes(1)
  })
  it.each([RTL_BULK_ENDPOINT, 1])(
    'reads endpoint address %s through WebUSB endpoint 1',
    async (endpoint) => {
      const data = Uint8Array.of(99, 0, 127, 255, 99)
      const transferIn = vi.fn(async (number: number) => {
        if (number < 1 || number > 15) throw new RangeError('Invalid endpoint number')
        return { status: 'ok' as const, data: new DataView(data.buffer, 1, 3) }
      })
      const transport = new WebUsbTransport({ transferIn } as unknown as WebUsbDevice)
      const bytes = await transport.bulkIn(endpoint, 262144)
      expect(transferIn).toHaveBeenCalledWith(1, 262144)
      expect(bytes).toEqual(Uint8Array.of(0, 127, 255))
    },
  )

  it('reports stalled bulk transfers', async () => {
    const transport = new WebUsbTransport({
      transferIn: async () => ({ status: 'stall' }),
    } as unknown as WebUsbDevice)
    await expect(transport.bulkIn(RTL_BULK_ENDPOINT, 512)).rejects.toThrow('stall')
  })
})
