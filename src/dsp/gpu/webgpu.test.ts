import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectWebGpu, isWebGpuAvailable, requestWebGpuDevice } from './webgpu'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WebGPU capability detection', () => {
  it('reports unavailable when navigator.gpu is missing', () => {
    vi.stubGlobal('navigator', {})
    expect(detectWebGpu()).toBe('unavailable')
    expect(isWebGpuAvailable()).toBe(false)
  })

  it('reports available when navigator.gpu is present', () => {
    vi.stubGlobal('navigator', { gpu: {} })
    expect(detectWebGpu()).toBe('available')
    expect(isWebGpuAvailable()).toBe(true)
  })

  it('returns the device from a successful adapter request', async () => {
    const device = { label: 'test-device' }
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: vi.fn(async () => ({ requestDevice: async () => device })) },
    })
    await expect(requestWebGpuDevice()).resolves.toBe(device)
  })

  it('returns null when no adapter is available', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => null } })
    await expect(requestWebGpuDevice()).resolves.toBeNull()
  })

  it('returns null when the adapter request rejects', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: async () => {
          throw new Error('denied')
        },
      },
    })
    await expect(requestWebGpuDevice()).resolves.toBeNull()
  })
})
