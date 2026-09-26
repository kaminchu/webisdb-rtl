/**
 * WebGPU capability detection and device acquisition.
 *
 * Detection is best-effort and must never throw: browsers without the WebGPU
 * API, insecure contexts and a denied adapter request all map to "unavailable"
 * so callers can fall back to the WASM DSP path.
 */

export type WebGpuStatus = 'available' | 'unavailable'

function gpuApi(): GPU | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as Navigator & { gpu?: GPU }).gpu ?? null
}

/** Synchronous probe used to enable or disable the settings toggle. */
export function detectWebGpu(): WebGpuStatus {
  return gpuApi() ? 'available' : 'unavailable'
}

export function isWebGpuAvailable(): boolean {
  return detectWebGpu() === 'available'
}

/** Request an adapter and device; resolves null whenever WebGPU is unusable. */
export async function requestWebGpuDevice(): Promise<GPUDevice | null> {
  const gpu = gpuApi()
  if (!gpu) return null
  try {
    const adapter = await gpu.requestAdapter()
    if (!adapter) return null
    return await adapter.requestDevice()
  } catch {
    return null
  }
}
