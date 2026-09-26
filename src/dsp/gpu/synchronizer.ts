/**
 * WebGPU guard-interval synchronizer.
 *
 * `GpuSynchronizer` mirrors the timing state machine of `SyncState` in
 * `wasm/dsp/src/ofdm.rs` (and `src/dsp/stages/ofdmSync.ts`) while the
 * `O(cpLength)` correlation for every candidate start runs as a batched WebGPU
 * kernel. The state machine is injected with a `SyncCorrelator`, so the exact
 * timing logic can be unit tested against the TypeScript reference with a pure
 * correlator and without a GPU.
 */

import type { OfdmSyncResult } from '../stages/ofdmSync'
import { SYNC_WGSL } from './shaders'
import { BUFFER_USAGE, MAP_MODE, SHADER_STAGE } from './gpuConstants'

const TIMING_SEARCH = 8
const WORKGROUP = 64
const SYNC_PARAM_FIELDS = 8

export interface SyncCorrelator {
  /** Stage the sample buffer that subsequent `correlate` calls index into. */
  prepare(re: Float32Array, im: Float32Array): void
  /**
   * Correlation metrics for `count` consecutive candidate starts beginning at
   * `start`, packed as `[metric, gammaRe, gammaIm, phi]` per candidate.
   */
  correlate(start: number, count: number): Promise<Float32Array>
  dispose(): void
}

interface Peak {
  index: number
  metric: number
  gammaRe: number
  gammaIm: number
  phi: number
}

export class GpuSynchronizer {
  private readonly correlator: SyncCorrelator
  private readonly n: number
  private readonly cpLength: number
  private readonly symbolLength: number
  private readonly sampleRateHz: number
  private readonly tracking: boolean

  private bufRe: Float32Array
  private bufIm: Float32Array
  private bufLen = 0
  private baseIndex = 0
  private nextStart = -1
  private synced = false
  private lastOffset: number | null = null
  private lastMetric = 0
  private lastGammaMag = 0
  private lastPhi = 0
  private disposed = false

  constructor(
    correlator: SyncCorrelator,
    fftSize: number,
    giRatio: number,
    sampleRateHz: number,
    tracking = false,
  ) {
    this.correlator = correlator
    this.n = fftSize
    this.cpLength = Math.floor(fftSize / giRatio)
    this.symbolLength = fftSize + this.cpLength
    this.sampleRateHz = sampleRateHz
    this.tracking = tracking
    const cap = 4 * this.symbolLength + fftSize
    this.bufRe = new Float32Array(cap)
    this.bufIm = new Float32Array(cap)
  }

  reset(): void {
    this.bufLen = 0
    this.baseIndex = 0
    this.nextStart = -1
    this.synced = false
    this.lastOffset = null
    this.lastMetric = 0
    this.lastGammaMag = 0
    this.lastPhi = 0
  }

  async process(re: Float32Array, im: Float32Array): Promise<OfdmSyncResult> {
    this.append(re, im)
    this.correlator.prepare(
      this.bufRe.subarray(0, this.bufLen),
      this.bufIm.subarray(0, this.bufLen),
    )
    const starts: number[] = []
    const end = this.baseIndex + this.bufLen

    if (!this.synced) {
      const maxStart = this.bufLen - (this.n + this.cpLength)
      if (maxStart >= 0) {
        const searchTo = Math.min(maxStart, 3 * this.symbolLength)
        const peak = await this.findPeak(0, searchTo)
        if (peak && peak.metric > 0) {
          this.synced = true
          this.nextStart = this.baseIndex + peak.index
          this.trackOffset(peak)
        } else {
          const keep = this.symbolLength + this.cpLength
          if (this.bufLen > keep) this.discardFront(this.bufLen - keep)
        }
      }
    }

    if (this.synced) {
      while (this.nextStart + this.symbolLength <= end) {
        const rel = this.nextStart - this.baseIndex
        const radius = this.tracking ? TIMING_SEARCH : 0
        if (rel - radius >= 0 && rel + this.n + this.cpLength + radius <= this.bufLen) {
          const peak = await this.findPeak(rel - radius, rel + radius)
          if (peak) {
            this.trackOffset(peak)
            if (this.tracking) this.nextStart = this.baseIndex + peak.index
          }
        }
        starts.push(this.nextStart + this.cpLength)
        this.nextStart += this.symbolLength
      }
      const keepFrom = Math.max(0, this.nextStart - this.baseIndex - this.cpLength)
      if (keepFrom > 0) this.discardFront(keepFrom)
    }

    return {
      symbolStarts: starts,
      fractionalOffsetHz: this.lastOffset,
      metric: this.lastMetric,
      gammaMagnitude: this.lastGammaMag,
      phi: this.lastPhi,
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.correlator.dispose()
  }

  private async findPeak(from: number, to: number): Promise<Peak | null> {
    const maxStart = this.bufLen - (this.n + this.cpLength)
    const hi = Math.min(to, maxStart)
    if (from > hi) return null
    const count = hi - from + 1
    const metrics = await this.correlator.correlate(from, count)
    let best: Peak | null = null
    for (let i = 0; i < count; i++) {
      const metric = metrics[i * 4]
      if (best === null || metric > best.metric) {
        best = {
          index: from + i,
          metric,
          gammaRe: metrics[i * 4 + 1],
          gammaIm: metrics[i * 4 + 2],
          phi: metrics[i * 4 + 3],
        }
      }
    }
    return best
  }

  private trackOffset(peak: Peak): void {
    const phase = Math.atan2(peak.gammaIm, peak.gammaRe)
    this.lastOffset = (-phase * this.sampleRateHz) / (2 * Math.PI * this.n)
    this.lastMetric = peak.metric
    this.lastGammaMag = Math.hypot(peak.gammaRe, peak.gammaIm)
    this.lastPhi = peak.phi
  }

  private ensureCapacity(extra: number): void {
    const need = this.bufLen + extra
    if (need <= this.bufRe.length) return
    let cap = this.bufRe.length || 1024
    while (cap < need) cap <<= 1
    const nr = new Float32Array(cap)
    nr.set(this.bufRe.subarray(0, this.bufLen))
    const ni = new Float32Array(cap)
    ni.set(this.bufIm.subarray(0, this.bufLen))
    this.bufRe = nr
    this.bufIm = ni
  }

  private append(re: Float32Array, im: Float32Array): void {
    const len = Math.min(re.length, im.length)
    this.ensureCapacity(len)
    this.bufRe.set(re.subarray(0, len), this.bufLen)
    this.bufIm.set(im.subarray(0, len), this.bufLen)
    this.bufLen += len
  }

  private discardFront(count: number): void {
    if (count <= 0) return
    this.bufRe.copyWithin(0, count, this.bufLen)
    this.bufIm.copyWithin(0, count, this.bufLen)
    this.bufLen -= count
    this.baseIndex += count
  }
}

export class GpuSyncCorrelator implements SyncCorrelator {
  private readonly device: GPUDevice
  private readonly pipeline: GPUComputePipeline
  private readonly layout: GPUBindGroupLayout
  private readonly uniform: GPUBuffer
  private readonly fftSize: number
  private readonly cpLength: number

  private reBuf: GPUBuffer | null = null
  private imBuf: GPUBuffer | null = null
  private outBuf: GPUBuffer | null = null
  private staging: GPUBuffer | null = null
  private bind: GPUBindGroup | null = null
  private sampleCapacity = 0
  private outCapacity = 0
  private disposed = false

  private constructor(
    device: GPUDevice,
    fftSize: number,
    cpLength: number,
    pipeline: GPUComputePipeline,
    layout: GPUBindGroupLayout,
  ) {
    this.device = device
    this.fftSize = fftSize
    this.cpLength = cpLength
    this.pipeline = pipeline
    this.layout = layout
    this.uniform = device.createBuffer({
      size: SYNC_PARAM_FIELDS * 4,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    })
  }

  static create(device: GPUDevice, fftSize: number, cpLength: number): GpuSyncCorrelator | null {
    try {
      const module = device.createShaderModule({ code: SYNC_WGSL })
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'storage' } },
          { binding: 3, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'uniform' } },
        ],
      })
      const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'sync_main' },
      })
      return new GpuSyncCorrelator(device, fftSize, cpLength, pipeline, layout)
    } catch {
      return null
    }
  }

  prepare(re: Float32Array, im: Float32Array): void {
    if (re.length > this.sampleCapacity) {
      this.reBuf?.destroy()
      this.imBuf?.destroy()
      this.reBuf = this.device.createBuffer({
        size: re.length * 4,
        usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST,
      })
      this.imBuf = this.device.createBuffer({
        size: re.length * 4,
        usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST,
      })
      this.sampleCapacity = re.length
    }
    if (this.reBuf && re.length > 0) this.device.queue.writeBuffer(this.reBuf, 0, re)
    if (this.imBuf && im.length > 0) this.device.queue.writeBuffer(this.imBuf, 0, im)
  }

  async correlate(start: number, count: number): Promise<Float32Array> {
    if (count <= 0) return new Float32Array(0)
    this.ensureOut(count)
    const params = new ArrayBuffer(SYNC_PARAM_FIELDS * 4)
    const view = new DataView(params)
    view.setUint32(0, this.fftSize, true)
    view.setUint32(4, this.cpLength, true)
    view.setUint32(8, count, true)
    view.setUint32(12, start, true)
    this.device.queue.writeBuffer(this.uniform, 0, params)
    this.bind = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.reBuf! } },
        { binding: 1, resource: { buffer: this.imBuf! } },
        { binding: 2, resource: { buffer: this.outBuf! } },
        { binding: 3, resource: { buffer: this.uniform } },
      ],
    })
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bind)
    pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP))
    pass.end()
    encoder.copyBufferToBuffer(this.outBuf!, 0, this.staging!, 0, count * 4 * 4)
    this.device.queue.submit([encoder.finish()])
    await this.staging!.mapAsync(MAP_MODE.READ)
    const result = new Float32Array(this.staging!.getMappedRange()).slice(0, count * 4)
    this.staging!.unmap()
    return result
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.uniform.destroy()
    this.release()
  }

  private ensureOut(count: number): void {
    if (count <= this.outCapacity) return
    this.outBuf?.destroy()
    this.staging?.destroy()
    this.outBuf = this.device.createBuffer({
      size: count * 4 * 4,
      usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC,
    })
    this.staging = this.device.createBuffer({
      size: count * 4 * 4,
      usage: BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST,
    })
    this.outCapacity = count
  }

  private release(): void {
    this.reBuf?.destroy()
    this.imBuf?.destroy()
    this.outBuf?.destroy()
    this.staging?.destroy()
    this.reBuf = null
    this.imBuf = null
    this.outBuf = null
    this.staging = null
    this.bind = null
    this.sampleCapacity = 0
    this.outCapacity = 0
  }
}
