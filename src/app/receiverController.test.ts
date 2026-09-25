import { describe, expect, it } from 'vitest'
import { RtlFrontendMode } from '../driver/rtlsdr/rtl2832u'
import { loadSettings, resetSettings } from '../storage/settings'
import { ReceiverController } from './receiverController'

type ConnectStub = { performConnect: () => Promise<void> }

describe('ReceiverController.connectRtlSdr', () => {
  it('coalesces concurrent connection attempts into one', async () => {
    const controller = new ReceiverController()
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ;(controller as unknown as ConnectStub).performConnect = async () => {
      calls++
      await gate
    }

    const first = controller.connectRtlSdr()
    const second = controller.connectRtlSdr()
    await Promise.resolve()
    expect(calls).toBe(1)

    release()
    await Promise.all([first, second])
  })

  it('allows a new attempt once the previous one settled', async () => {
    const controller = new ReceiverController()
    let calls = 0
    ;(controller as unknown as ConnectStub).performConnect = async () => {
      calls++
    }
    await controller.connectRtlSdr()
    await controller.connectRtlSdr()
    expect(calls).toBe(2)
  })

  it('propagates a failed attempt to every waiter', async () => {
    const controller = new ReceiverController()
    let calls = 0
    ;(controller as unknown as ConnectStub).performConnect = async () => {
      calls++
      throw new Error('boom')
    }
    const first = controller.connectRtlSdr()
    const second = controller.connectRtlSdr()
    await expect(first).rejects.toThrow('boom')
    await expect(second).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })
})

describe('ReceiverController.setFrontend', () => {
  it('persists the mode and tolerates no attached source', async () => {
    resetSettings()
    try {
      const controller = new ReceiverController()
      await controller.setFrontend(RtlFrontendMode.RealtekIsdbt)
      expect(loadSettings().frontend).toBe(RtlFrontendMode.RealtekIsdbt)
    } finally {
      resetSettings()
    }
  })
})
