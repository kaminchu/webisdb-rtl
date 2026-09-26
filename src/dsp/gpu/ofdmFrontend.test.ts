import { describe, expect, it } from 'vitest'
import { MODE_PARAMS } from '../isdbtParams'
import { segPilotReference } from '../wasm/demap'
import { WebGpuFrontend, type WebGpuFrontendParams } from './ofdmFrontend'

function params(): WebGpuFrontendParams {
  const mode = 3 as const
  const dataCount = MODE_PARAMS[mode].dataCarriersPerSegment
  return {
    mode,
    fftSize: MODE_PARAMS[mode].oneSegFftSize,
    gi: 8,
    sampleRate: 1_015_873,
    carrierBase: 0,
    fractionalOffsetHz: 0,
    spOffset: 0,
    frameStartSymbol: 0,
    carriersPerSegment: MODE_PARAMS[mode].carriersPerSegment,
    dataCount,
    segRef: segPilotReference(mode),
    dataIndices: [0, 1, 2, 3].map(() => Array.from({ length: dataCount }, (_, i) => i)),
    tmccCarriers: [],
  }
}

describe('WebGpuFrontend', () => {
  it('returns null when the device rejects shader or pipeline creation', () => {
    const device = {
      createShaderModule: () => {
        throw new Error('no webgpu')
      },
    } as unknown as GPUDevice
    expect(WebGpuFrontend.create(device, params())).toBeNull()
  })
})
