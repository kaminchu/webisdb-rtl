import { OneSegPipeline } from '../pipeline'
import { TransportStream } from '../../ts/TransportStream'

export async function checkPipeline() {
  const response = await fetch('/fixture')
  if (!response.ok) throw new Error(await response.text())
  const raw = new Uint8Array(await response.arrayBuffer())
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter unavailable')
  const device = await adapter.requestDevice()
  const errors: string[] = []
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message))
  let video = false
  let audio = false
  let bytes = 0
  let stats: unknown
  const states: string[] = []
  const transport = new TransportStream({
    onPes: (p) => {
      if (p.kind === 'video') video = true
      if (p.kind === 'audio') audio = true
    },
  })
  const pipeline = new OneSegPipeline(
    {
      onTs: (b) => {
        bytes += b.length
        transport.push(b)
      },
      onStats: (s) => {
        stats = s
      },
      onState: (s) => states.push(s),
    },
    { sourceSampleRate: 128_000_000 / 63, gpuDevice: device },
  )
  const start = performance.now()
  try {
    for (let off = 0; off < raw.length; off += 65536) {
      pipeline.pushIq({
        data: raw.subarray(off, off + 65536),
        format: 'u8',
        sampleRate: 128_000_000 / 63,
        centerFrequency: 509_142_857,
        sequence: off / 65536,
        timestamp: off / 2,
      })
      const due = ((off + 65536) / 2 / (128_000_000 / 63)) * 1000
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, due - (performance.now() - start))),
      )
    }
    await pipeline.flush()
    return {
      errors: errors.slice(0, 10),
      video,
      audio,
      bytes,
      states: states.slice(),
      stats,
      elapsed: performance.now() - start,
    }
  } finally {
    pipeline.dispose()
    device.destroy()
  }
}
