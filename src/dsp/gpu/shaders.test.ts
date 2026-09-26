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
    const result = await send<Evaluation>(
      'Runtime.evaluate',
      {
        expression: `(${checkShaders.toString()})(...${JSON.stringify([[OFDM_FRONTEND_WGSL, DEMAP_WGSL, SYNC_WGSL], BUFFER_USAGE, MAP_MODE])})`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    )
    expect(result.exceptionDetails, JSON.stringify(result.exceptionDetails)).toBeUndefined()
    expect(result.result.value).toEqual({
      errors: [],
      data: [2, -2, 3, -3, 3, -3, 4, -4],
      tmcc: [10, -10, 11, -11, 12, -12],
    })
  }, 30_000)

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
    const n = 32
    const count = 3
    const re = new Float32Array(n * count)
    const im = new Float32Array(n * count)
    const refs = Float32Array.from({ length: 24 }, (_, c) => (c % 2 ? -4 / 3 : 4 / 3))
    for (let s = 0; s < count; s++) {
      const put = (c: number, r: number, q: number) => {
        const bin = s * n + ((c - 4 + n) % n)
        re[bin] = r
        im[bin] = q
      }
      const hr = s + 1
      const hi = s * 0.25
      for (let c = 3 * ((s + 3) % 4); c < 24; c += 12) put(c, refs[c] * hr, refs[c] * hi)
      for (let k = 0; k < 2; k++) {
        const r = s + k + 1
        const q = -r
        put(4 + k, r * hr - q * hi, r * hi + q * hr)
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
    const out = output(2 * 2 * 2 * 4)
    const tmcc = output(count * 2 * 4)
    const buffers = [
      buffer(re),
      buffer(im),
      buffer(new Uint32Array([0, 0, 0, 1, 0, 2])),
      buffer(new Uint32Array([4, 5, 4, 5, 4, 5, 4, 5])),
      buffer(refs),
      buffer(new Uint32Array([7])),
      out,
      tmcc,
      buffer(new Uint32Array([n, count, -4, 24, 2, 1, 1, 3, 1, 8, 0, 0]), true),
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
    pass.dispatchWorkgroups(1)
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
    return { errors, data: values.slice(0, 8), tmcc: values.slice(8) }
  } finally {
    device.destroy()
  }
}
