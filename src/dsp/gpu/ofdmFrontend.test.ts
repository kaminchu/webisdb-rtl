import { describe, expect, it, vi } from 'vitest'
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
  it('reads full-stride planes for a partial batch and retains callback data across reuse', async () => {
    const count = 3
    const dataCount = 2
    const planesBytes = count * dataCount * 2 * Float32Array.BYTES_PER_ELEMENT
    // Decoded symbols are packed at each plane's start, but the stride includes all symbols.
    const out = new Float32Array([11, 12, 13, 14, -99, -99, 21, 22, 23, 24, -99, -99])
    const tmccOut = new Float32Array([31, 32, 33, 34, 35, 36])
    const mapped = new ArrayBuffer(planesBytes + tmccOut.byteLength)
    const staging = {
      mapAsync: vi.fn().mockResolvedValue(undefined),
      getMappedRange: () => mapped,
      unmap: vi.fn(() => new Float32Array(mapped).fill(-77)),
    }
    const copyBufferToBuffer = vi.fn(
      (
        source: Float32Array,
        sourceOffset: number,
        target: typeof staging,
        offset: number,
        size: number,
      ) => {
        new Uint8Array(target.getMappedRange(), offset, size).set(
          new Uint8Array(source.buffer, sourceOffset, size),
        )
      },
    )
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    }
    const onPlanes = vi.fn<(re: Float32Array, im: Float32Array, count: number) => void>()
    const consumeTmcc = vi.fn()
    const batch = {
      re: new Float32Array(count * 4),
      im: new Float32Array(count * 4),
      symbolIndex: new Uint32Array([0, 1, 2]),
      firstDecoded: 1,
      decodedCount: 2,
    }
    const frontend = Object.assign(Object.create(WebGpuFrontend.prototype), {
      device: {
        queue: { writeBuffer: vi.fn(), submit: vi.fn() },
        createCommandEncoder: () => ({
          beginComputePass: () => pass,
          copyBufferToBuffer,
          finish: vi.fn(),
        }),
      },
      params: params(),
      n: 4,
      dc: dataCount,
      cps: 4,
      tmccCount: 1,
      frameStart: 1,
      winStart: [0, 4, 8],
      winHead: 0,
      gpuReadbackMs: 0,
      gpuBatchMs: 0,
      gpuBatches: 0,
      disposed: false,
      out,
      tmccOut,
      staging,
      ensureCapacity: vi.fn(),
      consumeTmcc,
      callbacks: { onPlanes },
    }) as { processBatch(input: typeof batch): Promise<void> }

    await frontend.processBatch(batch)

    expect(copyBufferToBuffer).toHaveBeenNthCalledWith(1, out, 0, staging, 0, planesBytes)
    expect(copyBufferToBuffer).toHaveBeenNthCalledWith(
      2,
      tmccOut,
      0,
      staging,
      planesBytes,
      tmccOut.byteLength,
    )
    expect(consumeTmcc).toHaveBeenCalledWith(count, batch.symbolIndex, tmccOut)
    expect(onPlanes).toHaveBeenCalledExactlyOnceWith(
      new Float32Array([11, 12, 13, 14]),
      new Float32Array([21, 22, 23, 24]),
      2,
    )
    const [re, im] = onPlanes.mock.calls[0]

    out.fill(42)
    await frontend.processBatch(batch)

    expect(onPlanes).toHaveBeenNthCalledWith(
      2,
      new Float32Array(4).fill(42),
      new Float32Array(4).fill(42),
      2,
    )
    expect(re).toEqual(new Float32Array([11, 12, 13, 14]))
    expect(im).toEqual(new Float32Array([21, 22, 23, 24]))
    expect(staging.unmap).toHaveBeenCalledTimes(2)
  })

  it('returns null when the device rejects shader or pipeline creation', () => {
    const device = {
      createShaderModule: () => {
        throw new Error('no webgpu')
      },
    } as unknown as GPUDevice
    expect(WebGpuFrontend.create(device, params())).toBeNull()
  })
})
