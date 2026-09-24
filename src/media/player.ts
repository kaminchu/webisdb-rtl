import type { AvcConfig, PesPacket } from '../models/media'
import { AudioStreamDecoder } from './audioDecoder'
import type { AudioDecoderConfigInput } from './audioDecoder'
import { AvSync, SyncDecision, microsToPts90k, pts90kToMicros } from './avSync'
import { VideoStreamDecoder, isKeyframe } from './videoDecoder'
import type { VideoDecoderConfigInput } from './videoDecoder'

export interface OneSegPlayerOptions {
  audioContext?: AudioContext
  /** A/V sync render window in seconds. */
  toleranceSec?: number
}

export interface PlayerStats {
  videoSamples: number
  audioSamples: number
  videoFramesDecoded: number
  audioBuffersQueued: number
  dropped: number
  /** Raw PES PTS of the most recent packet, in 90 kHz units. */
  lastPts: number | null
}

const DEFAULT_VIDEO_CONFIG: VideoDecoderConfigInput = { codec: 'avc1.42E01E' }
const DEFAULT_AUDIO_CONFIG: AudioDecoderConfigInput = {
  codec: 'mp4a.40.2',
  sampleRate: 48000,
  numberOfChannels: 2,
}
const MAX_PENDING_FRAMES = 8
const CAPTURE_FPS = 30

function isCanvasElement(
  element: HTMLVideoElement | HTMLCanvasElement,
): element is HTMLCanvasElement {
  return typeof (element as HTMLCanvasElement).getContext === 'function'
}

/**
 * Ties demuxed PES packets to WebCodecs decoders and the A/V sync clock.
 *
 * Video frames are drawn to a 2D canvas. When the caller supplies an
 * `<video>` element, a hidden canvas is created and its `captureStream()` is
 * wired to the element (best effort; requires browser support). Without
 * WebCodecs the player counts packets and no-ops so the app keeps running.
 */
export class OneSegPlayer {
  private readonly canvas: HTMLCanvasElement
  private readonly context2d: CanvasRenderingContext2D | null
  private readonly videoDecoder: VideoStreamDecoder
  private readonly audioDecoder: AudioStreamDecoder
  private readonly avSync: AvSync
  private readonly pending: VideoFrame[] = []
  private drainScheduled = false
  private videoConfig: AvcConfig | VideoDecoderConfigInput | null = null
  private audioConfig: AudioDecoderConfigInput | null = null
  private lastPts: number | null = null
  private counters = {
    videoSamples: 0,
    audioSamples: 0,
    videoFramesDecoded: 0,
    audioBuffersQueued: 0,
    dropped: 0,
  }

  constructor(video: HTMLVideoElement | HTMLCanvasElement, options: OneSegPlayerOptions = {}) {
    if (isCanvasElement(video)) {
      this.canvas = video
    } else {
      this.canvas = createCanvas()
      attachCaptureStream(video, this.canvas)
    }
    this.context2d = this.canvas.getContext('2d')

    this.videoDecoder = new VideoStreamDecoder({ onFrame: (frame) => this.onVideoFrame(frame) })
    this.audioDecoder = new AudioStreamDecoder({
      ...(options.audioContext ? { audioContext: options.audioContext } : {}),
      onBufferQueued: () => {
        this.counters.audioBuffersQueued++
      },
    })
    this.avSync = new AvSync({
      audioClock: () => (this.audioDecoder.anchored ? this.audioDecoder.clockTime : null),
      ...(options.toleranceSec !== undefined ? { toleranceSec: options.toleranceSec } : {}),
    })
  }

  get stats(): PlayerStats {
    return {
      videoSamples: this.counters.videoSamples,
      audioSamples: this.counters.audioSamples,
      videoFramesDecoded: this.counters.videoFramesDecoded,
      audioBuffersQueued: this.counters.audioBuffersQueued,
      dropped: this.counters.dropped,
      lastPts: this.lastPts,
    }
  }

  /** Install the AVC configuration extracted from the PMT descriptor. */
  configureVideo(config: AvcConfig | VideoDecoderConfigInput): void {
    this.videoConfig = config
    this.videoDecoder.configure(config)
  }

  /** Install the AAC configuration extracted from the PMT descriptor. */
  configureAudio(config: AudioDecoderConfigInput): void {
    this.audioConfig = config
    this.audioDecoder.configure(config)
  }

  pushPes(packet: PesPacket): void {
    if (packet.kind === 'video') {
      this.counters.videoSamples++
      if (packet.pts !== undefined) this.lastPts = packet.pts
      if (!this.videoConfig) this.configureVideo(DEFAULT_VIDEO_CONFIG)
      this.videoDecoder.pushSample(
        packet.data,
        pts90kToMicros(packet.pts ?? 0),
        isKeyframe(packet.data),
      )
    } else if (packet.kind === 'audio') {
      this.counters.audioSamples++
      if (packet.pts !== undefined) this.lastPts = packet.pts
      if (!this.audioConfig) this.configureAudio(DEFAULT_AUDIO_CONFIG)
      this.audioDecoder.pushSample(packet.data, pts90kToMicros(packet.pts ?? 0))
    }
  }

  setMuted(muted: boolean): void {
    this.audioDecoder.setMuted(muted)
  }

  /** Flush decoders and the sync clock; used for LIVE recovery. */
  reset(): void {
    this.avSync.reset()
    this.videoDecoder.reset()
    this.audioDecoder.reset()
    this.clearPending()
  }

  close(): void {
    this.clearPending()
    this.videoDecoder.close()
    this.audioDecoder.close()
  }

  private onVideoFrame(frame: VideoFrame): void {
    const pts90k = microsToPts90k(frame.timestamp)
    if (!this.avSync.anchored) this.avSync.anchor(pts90k)
    const decision = this.avSync.decision(pts90k)
    if (decision === SyncDecision.Drop) {
      this.counters.dropped++
      frame.close()
      return
    }
    if (decision === SyncDecision.Hold) {
      this.pending.push(frame)
      if (this.pending.length > MAX_PENDING_FRAMES) {
        this.pending.shift()?.close()
        this.counters.dropped++
      }
      this.scheduleDrain()
      return
    }
    this.drawFrame(frame)
  }

  private drawFrame(frame: VideoFrame): void {
    try {
      const context = this.context2d
      if (context) {
        const width = frame.displayWidth || frame.codedWidth
        const height = frame.displayHeight || frame.codedHeight
        if (
          width > 0 &&
          height > 0 &&
          (this.canvas.width !== width || this.canvas.height !== height)
        ) {
          this.canvas.width = width
          this.canvas.height = height
        }
        context.drawImage(frame, 0, 0, width, height)
      }
      this.counters.videoFramesDecoded++
    } finally {
      frame.close()
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return
    this.drainScheduled = true
    const run = () => {
      this.drainScheduled = false
      this.drainPending()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
    else setTimeout(run, 16)
  }

  private drainPending(): void {
    if (this.pending.length === 0) return
    const remaining: VideoFrame[] = []
    for (const frame of this.pending) {
      const decision = this.avSync.decision(microsToPts90k(frame.timestamp))
      if (decision === SyncDecision.Render) this.drawFrame(frame)
      else if (decision === SyncDecision.Drop) {
        this.counters.dropped++
        frame.close()
      } else {
        remaining.push(frame)
      }
    }
    this.pending.length = 0
    this.pending.push(...remaining)
    if (this.pending.length > 0) this.scheduleDrain()
  }

  private clearPending(): void {
    for (const frame of this.pending) frame.close()
    this.pending.length = 0
  }
}

function createCanvas(): HTMLCanvasElement {
  return document.createElement('canvas')
}

function attachCaptureStream(video: HTMLVideoElement, canvas: HTMLCanvasElement): void {
  try {
    const stream = canvas.captureStream(CAPTURE_FPS)
    video.srcObject = stream
    const played = video.play()
    if (played) void played.catch(() => {})
  } catch {
    /* captureStream / play unavailable */
  }
}
