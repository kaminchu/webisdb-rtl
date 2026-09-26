/**
 * WebGPU OFDM front end for the locked-state path.
 *
 * Mirrors `WasmFrontend`: owns the sample buffer, symbol timing, TMCC decode and
 * the FFT/channel-estimation/equalization data path. NCO derotation, batched FFT,
 * scattered-pilot channel estimation and zero-forcing equalization run in
 * WebGPU compute kernels. Timing tracking and TMCC decoding stay in WASM:
 * tracking depends on each preceding symbol's peak, so GPU correlation would
 * require a blocking readback per symbol and stall real-time reception.
 *
 * Equalized data planes are read back once per batch and handed to `onPlanes`;
 * no FFT bin or intermediate plane crosses the host per symbol.
 */

import type { FrontendStats } from '../wasm/frontend'
import { WasmOfdmSynchronizer } from '../wasm/ofdm'
import { WasmTmccDecoder } from '../wasm/tmcc'
import type { TmccInfo } from '../../models/tmcc'
import type { TransmissionMode } from '../isdbtParams'
import { DEMAP_WGSL, OFDM_FRONTEND_WGSL } from './shaders'
import { BUFFER_USAGE, MAP_MODE, SHADER_STAGE } from './gpuConstants'

const MAX_BATCH = 16
const PARAMS_FIELDS = 12

const FFT_USAGE = BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST
const META_USAGE = BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST
const OUT_USAGE = BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_SRC
const STAGING_USAGE = BUFFER_USAGE.MAP_READ | BUFFER_USAGE.COPY_DST

export interface WebGpuFrontendParams {
  mode: TransmissionMode
  fftSize: number
  gi: number
  sampleRate: number
  carrierBase: number
  fractionalOffsetHz: number
  spOffset: number
  frameStartSymbol: number
  carriersPerSegment: number
  dataCount: number
  segRef: Float32Array
  dataIndices: readonly (readonly number[])[]
  tmccCarriers: readonly number[]
}

export interface WebGpuFrontendCallbacks {
  onPlanes?(re: Float32Array, im: Float32Array, symbolCount: number): void
  onError?(error: unknown): void
}

interface Batch {
  readonly re: Float32Array
  readonly im: Float32Array
  readonly symbolIndex: Uint32Array
  readonly firstDecoded: number
  readonly decodedCount: number
}

function initialTmccInfo(mode: TransmissionMode, gi: number): TmccInfo {
  return {
    locked: false,
    mode,
    guardIntervalRatio: gi,
    partialReception: false,
    systemDescriptor: null,
    layers: { A: null, B: null, C: null },
    frameCount: 0,
  }
}

export class WebGpuFrontend {
  private readonly device: GPUDevice
  private readonly params: WebGpuFrontendParams
  private readonly callbacks: WebGpuFrontendCallbacks
  private readonly n: number
  private readonly dc: number
  private readonly cps: number
  private readonly tmccCount: number
  private readonly frameStart: number

  private readonly sync: WasmOfdmSynchronizer
  private readonly tmcc: WasmTmccDecoder
  private readonly paramsBuffer: GPUBuffer
  private readonly dataIdxBuffer: GPUBuffer
  private readonly segRefBuffer: GPUBuffer
  private readonly tmccCarrierBuffer: GPUBuffer
  private readonly fftPipeline: GPUComputePipeline
  private readonly demapPipeline: GPUComputePipeline
  private readonly fftLayout: GPUBindGroupLayout
  private readonly demapLayout: GPUBindGroupLayout

  private sampleRe: GPUBuffer | null = null
  private sampleIm: GPUBuffer | null = null
  private fftRe: GPUBuffer | null = null
  private fftIm: GPUBuffer | null = null
  private meta: GPUBuffer | null = null
  private out: GPUBuffer | null = null
  private tmccOut: GPUBuffer | null = null
  private staging: GPUBuffer | null = null
  private fftBind: GPUBindGroup | null = null
  private demapBind: GPUBindGroup | null = null
  private capacity = 0

  private gpuBatchMs = 0
  private gpuReadbackMs = 0
  private gpuBatches = 0
  private readonly tmccRe: Float32Array
  private readonly tmccIm: Float32Array

  private bufRe = new Float32Array(1 << 16)
  private bufIm = new Float32Array(1 << 16)
  private bufLen = 0
  private bufStart = 0
  private pendingRe = new Float32Array(0)
  private pendingIm = new Float32Array(0)
  private pendingLen = 0

  private winRe: Float32Array
  private winIm: Float32Array
  private winStart: number[] = []
  private winSymbol: number[] = []
  private winCount = 0
  private winHead = 0
  private readonly batchRe: Float32Array
  private readonly batchIm: Float32Array
  private readonly batchSymbols = new Uint32Array(MAX_BATCH)

  private symbolIndex = 0
  private symbolsProcessed = 0
  private lastGammaMag = 0
  private lastPhi = 0
  private lastSignalPower = 0
  private lastMerDb: number | null = null
  private currentTmcc: TmccInfo
  private chain: Promise<void> = Promise.resolve()
  private draining = false
  private disposed = false

  private constructor(
    device: GPUDevice,
    params: WebGpuFrontendParams,
    callbacks: WebGpuFrontendCallbacks,
    resources: {
      fftPipeline: GPUComputePipeline
      demapPipeline: GPUComputePipeline
      fftLayout: GPUBindGroupLayout
      demapLayout: GPUBindGroupLayout
      synchronizer: WasmOfdmSynchronizer
    },
  ) {
    this.device = device
    this.params = params
    this.callbacks = callbacks
    this.n = params.fftSize
    this.dc = params.dataCount
    this.cps = params.carriersPerSegment
    this.tmccCount = params.tmccCarriers.length
    this.frameStart = Math.max(0, params.frameStartSymbol)
    this.winRe = new Float32Array(this.n * MAX_BATCH)
    this.winIm = new Float32Array(this.n * MAX_BATCH)
    this.batchRe = new Float32Array(this.n * MAX_BATCH)
    this.batchIm = new Float32Array(this.n * MAX_BATCH)
    this.tmccRe = new Float32Array(this.tmccCount)
    this.tmccIm = new Float32Array(this.tmccCount)
    this.fftPipeline = resources.fftPipeline
    this.demapPipeline = resources.demapPipeline
    this.fftLayout = resources.fftLayout
    this.demapLayout = resources.demapLayout
    this.sync = resources.synchronizer
    this.tmcc = new WasmTmccDecoder(params.mode, params.gi)
    this.currentTmcc = initialTmccInfo(params.mode, params.gi)
    this.paramsBuffer = device.createBuffer({
      size: PARAMS_FIELDS * 4,
      usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
    })
    const dataIdx = new Uint32Array(4 * this.dc)
    for (let phase = 0; phase < 4; phase++) {
      dataIdx.set(params.dataIndices[phase].slice(0, this.dc), phase * this.dc)
    }
    this.dataIdxBuffer = this.staticBuffer(dataIdx)
    this.segRefBuffer = this.staticBuffer(params.segRef.subarray(0, this.cps))
    this.tmccCarrierBuffer = this.staticBuffer(Uint32Array.from(params.tmccCarriers))
  }

  static create(
    device: GPUDevice,
    params: WebGpuFrontendParams,
    callbacks: WebGpuFrontendCallbacks = {},
  ): WebGpuFrontend | null {
    try {
      const fftModule = device.createShaderModule({ code: OFDM_FRONTEND_WGSL })
      const demapModule = device.createShaderModule({ code: DEMAP_WGSL })
      const fftLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'storage' } },
          { binding: 3, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'storage' } },
          { binding: 4, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 5, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'uniform' } },
        ],
      })
      const demapLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 4, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 5, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 6, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'storage' } },
          { binding: 7, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'storage' } },
          { binding: 8, visibility: SHADER_STAGE.COMPUTE, buffer: { type: 'uniform' } },
        ],
      })
      const fftPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [fftLayout] }),
        compute: { module: fftModule, entryPoint: 'fft_main' },
      })
      const demapPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [demapLayout] }),
        compute: { module: demapModule, entryPoint: 'demap_main' },
      })
      const synchronizer = new WasmOfdmSynchronizer(
        params.fftSize,
        params.gi,
        params.sampleRate,
        true,
      )
      return new WebGpuFrontend(device, params, callbacks, {
        fftPipeline,
        demapPipeline,
        fftLayout,
        demapLayout,
        synchronizer,
      })
    } catch {
      return null
    }
  }

  /** Append resampled complex samples; symbol windows are queued for the GPU. */
  push(re: Float32Array, im: Float32Array): void {
    if (this.disposed || re.length === 0) return
    this.appendPending(re, im)
    this.schedule()
  }

  stats(): FrontendStats {
    return {
      gammaMagnitude: this.lastGammaMag,
      phi: this.lastPhi,
      signalPower: this.lastSignalPower,
      merDb: this.lastMerDb,
      symbolsProcessed: this.symbolsProcessed,
      gpuBatchMs: this.gpuBatchMs,
      gpuReadbackMs: this.gpuReadbackMs,
      gpuBatches: this.gpuBatches,
    }
  }

  tmccInfo(): TmccInfo {
    return this.currentTmcc
  }

  /** Wait for every queued window to finish and its planes to be delivered. */
  async finish(): Promise<void> {
    this.schedule()
    await this.chain
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sync.dispose()
    this.tmcc.dispose()
    this.paramsBuffer.destroy()
    this.dataIdxBuffer.destroy()
    this.segRefBuffer.destroy()
    this.tmccCarrierBuffer.destroy()
    this.releaseGpu()
  }

  private staticBuffer(data: Uint32Array | Float32Array): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: Math.max(4, data.byteLength),
      usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.COPY_DST,
    })
    this.device.queue.writeBuffer(buffer, 0, data)
    return buffer
  }

  private appendPending(re: Float32Array, im: Float32Array): void {
    const need = this.pendingLen + re.length
    if (need > this.pendingRe.length) {
      let cap = this.pendingRe.length || 1 << 14
      while (cap < need) cap <<= 1
      const nr = new Float32Array(cap)
      nr.set(this.pendingRe.subarray(0, this.pendingLen))
      const ni = new Float32Array(cap)
      ni.set(this.pendingIm.subarray(0, this.pendingLen))
      this.pendingRe = nr
      this.pendingIm = ni
    }
    this.pendingRe.set(re, this.pendingLen)
    this.pendingIm.set(im, this.pendingLen)
    this.pendingLen += re.length
  }

  private appendToBuffer(re: Float32Array, im: Float32Array): void {
    const need = this.bufLen + re.length
    if (need > this.bufRe.length) {
      let cap = this.bufRe.length || 1024
      while (cap < need) cap <<= 1
      const nr = new Float32Array(cap)
      nr.set(this.bufRe.subarray(0, this.bufLen))
      const ni = new Float32Array(cap)
      ni.set(this.bufIm.subarray(0, this.bufLen))
      this.bufRe = nr
      this.bufIm = ni
    }
    this.bufRe.set(re, this.bufLen)
    this.bufIm.set(im, this.bufLen)
    this.bufLen += re.length
  }

  private trimBuffer(): void {
    const keep = 2 * this.n
    if (this.bufLen <= keep) return
    const drop = this.bufLen - keep
    this.bufRe.copyWithin(0, drop, this.bufLen)
    this.bufIm.copyWithin(0, drop, this.bufLen)
    this.bufLen -= drop
    this.bufStart += drop
  }

  private enqueueWindow(rel: number, symbolIndex: number): void {
    const need = (this.winCount + 1) * this.n
    if (need > this.winRe.length) {
      let cap = this.winRe.length || this.n * MAX_BATCH
      while (cap < need) cap <<= 1
      const nr = new Float32Array(cap)
      nr.set(this.winRe.subarray(0, this.winCount * this.n))
      const ni = new Float32Array(cap)
      ni.set(this.winIm.subarray(0, this.winCount * this.n))
      this.winRe = nr
      this.winIm = ni
    }
    const offset = this.winCount * this.n
    this.winRe.set(this.bufRe.subarray(rel, rel + this.n), offset)
    this.winIm.set(this.bufIm.subarray(rel, rel + this.n), offset)
    this.winStart.push(this.bufStart + rel)
    this.winSymbol.push(symbolIndex)
    this.winCount += 1
  }

  private schedule(): void {
    if (this.draining) return
    this.draining = true
    this.chain = this.chain
      .then(() => this.drain())
      .catch((error: unknown) => {
        this.callbacks.onError?.(error)
      })
      .finally(() => {
        this.draining = false
      })
  }

  private async drain(): Promise<void> {
    while (!this.disposed && (this.pendingLen > 0 || this.winHead < this.winCount)) {
      if (this.pendingLen > 0) {
        const len = this.pendingLen
        const re = this.pendingRe.subarray(0, len)
        const im = this.pendingIm.subarray(0, len)
        this.pendingLen = 0
        this.appendToBuffer(re, im)
        const fed = this.sync.process(re, im)
        if (this.disposed) return
        this.lastGammaMag = fed.gammaMagnitude
        this.lastPhi = fed.phi
        for (const raw of fed.symbolStarts) {
          const start = Math.round(raw)
          const rel = start - this.bufStart
          if (rel < 0 || rel + this.n > this.bufLen) continue
          this.enqueueWindow(rel, this.symbolIndex)
          this.symbolIndex += 1
          this.symbolsProcessed += 1
        }
        this.trimBuffer()
      }
      while (!this.disposed && this.winHead < this.winCount) {
        const count = Math.min(MAX_BATCH, this.winCount - this.winHead)
        const batch = this.collectBatch(count)
        await this.processBatch(batch)
        this.winHead += count
      }
      this.compactWindows()
    }
  }

  private compactWindows(): void {
    if (this.winHead === 0) return
    const remaining = this.winCount - this.winHead
    if (remaining > 0) {
      this.winRe.copyWithin(0, this.winHead * this.n, this.winCount * this.n)
      this.winIm.copyWithin(0, this.winHead * this.n, this.winCount * this.n)
      this.winStart.splice(0, this.winHead)
      this.winSymbol.splice(0, this.winHead)
    } else {
      this.winStart.length = 0
      this.winSymbol.length = 0
    }
    this.winCount = remaining
    this.winHead = 0
  }

  private collectBatch(count: number): Batch {
    const re = this.batchRe.subarray(0, count * this.n)
    const im = this.batchIm.subarray(0, count * this.n)
    const symbolIndex = this.batchSymbols.subarray(0, count)
    for (let i = 0; i < count; i++) {
      const src = (this.winHead + i) * this.n
      re.set(this.winRe.subarray(src, src + this.n), i * this.n)
      im.set(this.winIm.subarray(src, src + this.n), i * this.n)
      symbolIndex[i] = this.winSymbol[this.winHead + i]
    }
    let firstDecoded = count
    for (let i = 0; i < count; i++) {
      if (symbolIndex[i] >= this.frameStart) {
        firstDecoded = i
        break
      }
    }
    return {
      re,
      im,
      symbolIndex,
      firstDecoded,
      decodedCount: count - firstDecoded,
    }
  }

  private async processBatch(batch: Batch): Promise<void> {
    const count = batch.symbolIndex.length
    this.ensureCapacity(count)
    const { device } = this
    const startedAt = performance.now()
    const meta = new Uint32Array(2 * count)
    for (let i = 0; i < count; i++) {
      meta[2 * i] = this.winStart[this.winHead + i] >>> 0
      meta[2 * i + 1] = batch.symbolIndex[i]
    }
    const params = new ArrayBuffer(PARAMS_FIELDS * 4)
    const view = new DataView(params)
    view.setUint32(0, this.n, true)
    view.setUint32(4, count, true)
    view.setInt32(8, this.params.carrierBase, true)
    view.setUint32(12, this.cps, true)
    view.setUint32(16, this.dc, true)
    view.setUint32(20, this.tmccCount, true)
    view.setUint32(24, this.frameStart, true)
    view.setUint32(28, this.params.spOffset, true)
    view.setUint32(32, batch.firstDecoded, true)
    view.setUint32(36, this.params.gi, true)
    view.setFloat32(40, this.params.sampleRate, true)
    view.setFloat32(44, this.params.fractionalOffsetHz, true)

    const queue = device.queue
    queue.writeBuffer(this.sampleRe!, 0, batch.re)
    queue.writeBuffer(this.sampleIm!, 0, batch.im)
    queue.writeBuffer(this.meta!, 0, meta)
    queue.writeBuffer(this.paramsBuffer, 0, params)

    const planesBytes = count * this.dc * 2 * 4
    const tmccBytes = count * this.tmccCount * 2 * 4

    const encoder = device.createCommandEncoder()
    const fftPass = encoder.beginComputePass()
    fftPass.setPipeline(this.fftPipeline)
    fftPass.setBindGroup(0, this.fftBind!)
    fftPass.dispatchWorkgroups(count)
    fftPass.end()
    const demapPass = encoder.beginComputePass()
    demapPass.setPipeline(this.demapPipeline)
    demapPass.setBindGroup(0, this.demapBind!)
    demapPass.dispatchWorkgroups(count)
    demapPass.end()
    encoder.copyBufferToBuffer(this.out!, 0, this.staging!, 0, planesBytes)
    encoder.copyBufferToBuffer(this.tmccOut!, 0, this.staging!, planesBytes, Math.max(4, tmccBytes))
    queue.submit([encoder.finish()])

    const readStarted = performance.now()
    await this.staging!.mapAsync(MAP_MODE.READ)
    this.gpuReadbackMs += performance.now() - readStarted
    if (this.disposed) {
      this.staging!.unmap()
      return
    }
    const mapped = new Float32Array(this.staging!.getMappedRange())
    const planesCopy = mapped.slice(0, count * this.dc * 2)
    const tmccCopy = mapped.slice(
      count * this.dc * 2,
      count * this.dc * 2 + count * this.tmccCount * 2,
    )
    this.staging!.unmap()
    this.gpuBatchMs += performance.now() - startedAt
    this.gpuBatches += 1
    if (this.disposed) return

    this.consumeTmcc(count, batch.symbolIndex, tmccCopy)
    if (batch.decodedCount > 0) this.consumePlanes(batch, planesCopy)
  }

  private consumeTmcc(count: number, symbolIndex: Uint32Array, bins: Float32Array): void {
    const tr = this.tmccRe
    const ti = this.tmccIm
    for (let s = 0; s < count; s++) {
      const angle =
        (-2 * Math.PI * (this.params.carrierBase + this.cps / 2) * symbolIndex[s]) / this.params.gi
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      for (let c = 0; c < this.tmccCount; c++) {
        const br = bins[(s * this.tmccCount + c) * 2]
        const bi = bins[(s * this.tmccCount + c) * 2 + 1]
        tr[c] = br * cos - bi * sin
        ti[c] = br * sin + bi * cos
      }
      this.currentTmcc = this.tmcc.push(tr, ti)
    }
  }

  private consumePlanes(batch: Batch, planes: Float32Array): void {
    const dc = this.dc
    const base = batch.decodedCount * dc
    const re = planes.subarray(0, base)
    const im = planes.subarray(batch.symbolIndex.length * dc, batch.symbolIndex.length * dc + base)
    for (let s = 0; s < batch.decodedCount; s++) {
      const symbolIndex = batch.symbolIndex[batch.firstDecoded + s]
      if (symbolIndex % 4 !== 0) continue
      let power = 0
      const off = s * dc
      for (let k = 0; k < dc; k++) {
        const r = re[off + k]
        const q = im[off + k]
        power += r * r + q * q
      }
      this.updateMer(re, im, s, power)
    }
    this.callbacks.onPlanes?.(re, im, batch.decodedCount)
  }

  private updateMer(re: Float32Array, im: Float32Array, symbol: number, power: number): void {
    power /= this.dc
    this.lastSignalPower = power
    const scale = Math.sqrt(power / 2)
    let err = 0
    const base = symbol * this.dc
    for (let k = 0; k < this.dc; k++) {
      const r = re[base + k]
      const q = im[base + k]
      const idealRe = r >= 0 ? scale : -scale
      const idealIm = q >= 0 ? scale : -scale
      err += (r - idealRe) * (r - idealRe) + (q - idealIm) * (q - idealIm)
    }
    err /= this.dc
    this.lastMerDb = power > 0 && err > 0 ? 10 * Math.log10(power / err) : null
  }

  private ensureCapacity(count: number): void {
    if (count <= this.capacity) return
    this.releaseGpu()
    const n = this.n
    const { device } = this
    this.sampleRe = device.createBuffer({ size: count * n * 4, usage: FFT_USAGE })
    this.sampleIm = device.createBuffer({ size: count * n * 4, usage: FFT_USAGE })
    this.fftRe = device.createBuffer({ size: count * n * 4, usage: FFT_USAGE })
    this.fftIm = device.createBuffer({ size: count * n * 4, usage: FFT_USAGE })
    this.meta = device.createBuffer({ size: count * 8, usage: META_USAGE })
    this.out = device.createBuffer({ size: count * this.dc * 8, usage: OUT_USAGE })
    this.tmccOut = device.createBuffer({ size: count * this.tmccCount * 8, usage: OUT_USAGE })
    this.staging = device.createBuffer({
      size: Math.max(4, count * this.dc * 8 + count * this.tmccCount * 8),
      usage: STAGING_USAGE,
    })
    this.fftBind = device.createBindGroup({
      layout: this.fftLayout,
      entries: [
        { binding: 0, resource: { buffer: this.sampleRe! } },
        { binding: 1, resource: { buffer: this.sampleIm! } },
        { binding: 2, resource: { buffer: this.fftRe! } },
        { binding: 3, resource: { buffer: this.fftIm! } },
        { binding: 4, resource: { buffer: this.meta! } },
        { binding: 5, resource: { buffer: this.paramsBuffer } },
      ],
    })
    this.demapBind = device.createBindGroup({
      layout: this.demapLayout,
      entries: [
        { binding: 0, resource: { buffer: this.fftRe! } },
        { binding: 1, resource: { buffer: this.fftIm! } },
        { binding: 2, resource: { buffer: this.meta! } },
        { binding: 3, resource: { buffer: this.dataIdxBuffer } },
        { binding: 4, resource: { buffer: this.segRefBuffer } },
        { binding: 5, resource: { buffer: this.tmccCarrierBuffer } },
        { binding: 6, resource: { buffer: this.out! } },
        { binding: 7, resource: { buffer: this.tmccOut! } },
        { binding: 8, resource: { buffer: this.paramsBuffer } },
      ],
    })
    this.capacity = count
  }

  private releaseGpu(): void {
    this.sampleRe?.destroy()
    this.sampleIm?.destroy()
    this.fftRe?.destroy()
    this.fftIm?.destroy()
    this.meta?.destroy()
    this.out?.destroy()
    this.tmccOut?.destroy()
    this.staging?.destroy()
    this.sampleRe = null
    this.sampleIm = null
    this.fftRe = null
    this.fftIm = null
    this.meta = null
    this.out = null
    this.tmccOut = null
    this.staging = null
    this.fftBind = null
    this.demapBind = null
    this.capacity = 0
  }
}
