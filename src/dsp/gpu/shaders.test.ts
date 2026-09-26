// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEMAP_WGSL, OFDM_FRONTEND_WGSL, SYNC_WGSL } from './shaders'
import { BUFFER_USAGE, MAP_MODE } from './gpuConstants'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import type { checkPipeline } from './pipeline.browser'

interface ProtocolReply {
  id: number
  error?: unknown
  result: unknown
}

interface Evaluation<T = unknown> {
  exceptionDetails?: unknown
  result: { value?: T }
}

describe.skipIf(!process.env.WEBGPU_CHROME)('WGSL on a WebGPU device', () => {
  let browser: ChildProcess
  let server: Server
  let vite: ViteDevServer
  let profile: string
  let sessionId: string
  let sequence = 0
  const pending = new Map<number, (message: ProtocolReply) => void>()

  function send<T = unknown>(method: string, params = {}, session?: string): Promise<T> {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      pending.set(id, (message) =>
        message.error
          ? reject(new Error(JSON.stringify(message.error)))
          : resolve(message.result as T),
      )
      ;(browser.stdio[3] as Writable).write(
        JSON.stringify({ id, method, params, sessionId: session }) + '\0',
      )
    })
  }

  beforeAll(async () => {
    vite = await createViteServer({
      configFile: false,
      server: { middlewareMode: true },
      appType: 'custom',
    })
    server = createServer((req, res) => {
      if (req.url === '/') res.end('<!doctype html><title>WebGPU test</title>')
      else if (req.url === '/fixture' && process.env.WEBGPU_IQ_FILE) {
        void readFile(process.env.WEBGPU_IQ_FILE).then(
          (data) => res.end(data),
          (error: unknown) => {
            res.statusCode = 500
            res.end(String(error))
          },
        )
      } else vite.middlewares(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    profile = await mkdtemp(join(tmpdir(), 'webisdb-gpu-'))
    browser = spawn(
      process.env.WEBGPU_CHROME!,
      [
        '--headless',
        '--no-sandbox',
        '--enable-unsafe-webgpu',
        '--use-angle=swiftshader',
        '--remote-debugging-pipe',
        `--user-data-dir=${profile}`,
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
    )
    let buffered = ''
    ;(browser.stdio[4] as Readable).on('data', (data: Buffer) => {
      buffered += data.toString()
      let end: number
      while ((end = buffered.indexOf('\0')) >= 0) {
        const message = JSON.parse(buffered.slice(0, end))
        buffered = buffered.slice(end + 1)
        pending.get(message.id)?.(message)
        pending.delete(message.id)
      }
    })
    const { targetId } = await send<{ targetId: string }>('Target.createTarget', {
      url: `http://127.0.0.1:${address.port}`,
    })
    ;({ sessionId } = await send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    }))
    await send('Runtime.enable', {}, sessionId)
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await send<Evaluation>(
        'Runtime.evaluate',
        {
          expression:
            'location.href.startsWith("http://127.0.0.1:") && document.readyState === "complete"',
        },
        sessionId,
      )
      if (ready.result.value) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Test page did not load')
  }, 30_000)

  afterAll(async () => {
    if (browser && browser.exitCode === null) {
      const exited = new Promise<void>((resolve) => browser.once('exit', () => resolve()))
      browser.kill()
      await exited
    }
    server?.close()
    await vite?.close()
    if (profile) await rm(profile, { recursive: true, force: true })
  })

  it('compiles all kernels and demaps each symbol from its own FFT plane', async () => {
    const result = await send<Evaluation<{ errors: string[]; data: number[]; tmcc: number[] }>>(
      'Runtime.evaluate',
      {
        expression: `(${checkShaders.toString()})(...${JSON.stringify([[OFDM_FRONTEND_WGSL, DEMAP_WGSL, SYNC_WGSL], BUFFER_USAGE, MAP_MODE])})`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    )
    expect(result.exceptionDetails, JSON.stringify(result.exceptionDetails)).toBeUndefined()
    const value = result.result.value!
    expect(value.errors).toEqual([])
    expect(value.tmcc).toEqual([10, -10, 11, -11, 12, -12, 13, -13, 14, -14, 15, -15])
    expect(value.data).toHaveLength(6 * 130 * 2)
    for (let s = 0; s < 6; s++) {
      for (let k = 0; k < 130; k++) {
        const expected = s < 5 ? s + k + 2 : 0
        expect(value.data[s * 130 + k]).toBeCloseTo(expected, 3)
        expect(value.data[6 * 130 + s * 130 + k]).toBeCloseTo(-expected, 3)
      }
    }
  }, 30_000)

  it.each([256, 512, 1024])(
    'FFT size %i matches a direct complex DFT',
    async (n) => {
      const result = await send<Evaluation<{ errors: string[]; maxError: number }>>(
        'Runtime.evaluate',
        {
          expression: `(${checkFft.toString()})(...${JSON.stringify([OFDM_FRONTEND_WGSL, BUFFER_USAGE, MAP_MODE, n])})`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      )
      expect(result.exceptionDetails, JSON.stringify(result.exceptionDetails)).toBeUndefined()
      expect(result.result.value!.errors).toEqual([])
      // WGSL trig is approximate; compare unnormalized FFT error per input sample.
      expect(result.result.value!.maxError / n).toBeLessThan(0.0002)
    },
    30_000,
  )

  it.skipIf(!process.env.WEBGPU_IQ_FILE)(
    'decodes real IQ through the GPU pipeline',
    async () => {
      const result = await send<Evaluation<Awaited<ReturnType<typeof checkPipeline>>>>(
        'Runtime.evaluate',
        {
          expression: `import('/src/dsp/gpu/pipeline.browser.ts').then(m => m.checkPipeline())`,
          awaitPromise: true,
          returnByValue: true,
        },
        sessionId,
      )
      expect(result.exceptionDetails, JSON.stringify(result.exceptionDetails)).toBeUndefined()
      expect(result.result.value).toMatchObject({
        errors: [],
        video: true,
        audio: true,
        states: ['acquiring', 'locked'],
      })
      expect(result.result.value!.bytes).toBeGreaterThan(188 * 100)
    },
    120_000,
  )
})

async function checkShaders(
  sources: string[],
  usage: typeof BUFFER_USAGE,
  mapMode: typeof MAP_MODE,
) {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter unavailable')
  const device = await adapter.requestDevice()
  try {
    device.pushErrorScope('validation')
    const modules = sources.map((code) => device.createShaderModule({ code }))
    const errors: string[] = []
    for (const module of modules) {
      const info = await module.getCompilationInfo()
      errors.push(...info.messages.filter((m) => m.type === 'error').map((m) => m.message))
    }
    if (errors.length) return { errors }
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: modules[1], entryPoint: 'demap_main' },
    })
    const n = 256
    const count = 6
    const dc = 130
    const cps = 216
    const re = new Float32Array(n * count)
    const im = new Float32Array(n * count)
    const refs = Float32Array.from({ length: cps }, (_, c) => (c % 2 ? -4 / 3 : 4 / 3))
    const indices = Array.from({ length: 4 }, (_, phase) => [
      ...Array.from({ length: cps - 1 }, (_carrier, c) => c)
        .filter((c) => c % 12 !== phase * 3 && c !== 7)
        .slice(0, dc - 1),
      cps - 1,
    ])
    for (let s = 0; s < count; s++) {
      const put = (c: number, r: number, q: number) => {
        const bin = s * n + ((c - 4 + n) % n)
        re[bin] = r
        im[bin] = q
      }
      const hr = s + 1
      const hi = s * 0.25
      for (let c = 3 * ((s + 3) % 4); c < cps; c += 12) put(c, refs[c] * hr, refs[c] * hi)
      for (let k = 0; k < dc; k++) {
        const r = s + k + 1
        const q = -r
        put(indices[(s + 3) % 4][k], r * hr - q * hi, r * hi + q * hr)
      }
      put(7, 10 + s, -10 - s)
    }
    const buffer = (data: Float32Array | Uint32Array, uniform = false) => {
      const b = device.createBuffer({
        size: data.byteLength,
        usage: (uniform ? usage.UNIFORM : usage.STORAGE) | usage.COPY_DST,
      })
      device.queue.writeBuffer(b, 0, data)
      return b
    }
    const output = (size: number) =>
      device.createBuffer({ size, usage: usage.STORAGE | usage.COPY_SRC })
    const out = output(count * dc * 2 * 4)
    const tmcc = output(count * 2 * 4)
    const buffers = [
      buffer(re),
      buffer(im),
      buffer(new Uint32Array([0, 0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5])),
      buffer(new Uint32Array(indices.flat())),
      buffer(refs),
      buffer(new Uint32Array([7])),
      out,
      tmcc,
      buffer(new Uint32Array([n, count, -4, cps, dc, 1, 1, 3, 1, 8, 0, 0]), true),
    ]
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((b, binding) => ({ binding, resource: { buffer: b } })),
    })
    const staging = device.createBuffer({
      size: out.size + tmcc.size,
      usage: usage.MAP_READ | usage.COPY_DST,
    })
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bind)
    pass.dispatchWorkgroups(count)
    pass.end()
    encoder.copyBufferToBuffer(out, 0, staging, 0, out.size)
    encoder.copyBufferToBuffer(tmcc, 0, staging, out.size, tmcc.size)
    device.queue.submit([encoder.finish()])
    await staging.mapAsync(mapMode.READ)
    const values = Array.from(
      new Float32Array(staging.getMappedRange()),
      (v) => Math.round(v * 1e5) / 1e5,
    )
    staging.unmap()
    const error = await device.popErrorScope()
    if (error) errors.push(error.message)
    return { errors, data: values.slice(0, count * dc * 2), tmcc: values.slice(count * dc * 2) }
  } finally {
    device.destroy()
  }
}

async function checkFft(
  source: string,
  usage: typeof BUFFER_USAGE,
  mapMode: typeof MAP_MODE,
  n: number,
) {
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter unavailable')
  const device = await adapter.requestDevice()
  try {
    device.pushErrorScope('validation')
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: source }), entryPoint: 'fft_main' },
    })
    const count = 3
    const starts = [37, 1901, 8197]
    const re = Float32Array.from(
      { length: n * count },
      (_, i) => Math.sin(i * 0.173) * 0.7 + (((i * 17) % 101) - 50) / 101,
    )
    const im = Float32Array.from(
      { length: n * count },
      (_, i) => Math.cos(i * 0.071) * 0.4 + (((i * 31) % 97) - 48) / 97,
    )
    let maxError = 0
    for (const cfo of [0, 137.25, -219.5]) {
      const resources: GPUBuffer[] = []
      const buffer = (
        size: number,
        flags: number,
        data?: ArrayBuffer | Float32Array | Uint32Array,
      ) => {
        const b = device.createBuffer({ size, usage: flags })
        resources.push(b)
        if (data) device.queue.writeBuffer(b, 0, data)
        return b
      }
      const bytes = n * count * 4
      const inputUsage = usage.STORAGE | usage.COPY_DST
      const outputUsage = usage.STORAGE | usage.COPY_SRC
      const params = new ArrayBuffer(48)
      const view = new DataView(params)
      view.setUint32(0, n, true)
      view.setUint32(4, count, true)
      view.setFloat32(40, 1_000_000, true)
      view.setFloat32(44, cfo, true)
      const buffers = [
        buffer(bytes, inputUsage, re),
        buffer(bytes, inputUsage, im),
        buffer(bytes, outputUsage),
        buffer(bytes, outputUsage),
        buffer(count * 8, inputUsage, new Uint32Array(starts.flatMap((start, s) => [start, s]))),
        buffer(48, usage.UNIFORM | usage.COPY_DST, params),
      ]
      const staging = buffer(bytes * 2, usage.MAP_READ | usage.COPY_DST)
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: buffers.map((b, binding) => ({ binding, resource: { buffer: b } })),
      })
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bind)
      pass.dispatchWorkgroups(count + 1)
      pass.end()
      encoder.copyBufferToBuffer(buffers[2], 0, staging, 0, bytes)
      encoder.copyBufferToBuffer(buffers[3], 0, staging, bytes, bytes)
      device.queue.submit([encoder.finish()])
      await staging.mapAsync(mapMode.READ)
      const actual = new Float32Array(staging.getMappedRange())
      for (let s = 0; s < count; s++) {
        for (let k = 0; k < n; k++) {
          let r = 0
          let q = 0
          for (let i = 0; i < n; i++) {
            const angle = -2 * Math.PI * ((k * i) / n + (cfo * (starts[s] + i)) / 1_000_000)
            const c = Math.cos(angle)
            const sn = Math.sin(angle)
            r += re[s * n + i] * c - im[s * n + i] * sn
            q += re[s * n + i] * sn + im[s * n + i] * c
          }
          maxError = Math.max(
            maxError,
            Math.abs(actual[s * n + k] - r),
            Math.abs(actual[n * count + s * n + k] - q),
          )
        }
      }
      staging.unmap()
      for (const b of resources) b.destroy()
    }
    const error = await device.popErrorScope()
    return { errors: error ? [error.message] : [], maxError }
  } finally {
    device.destroy()
  }
}
