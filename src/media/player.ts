import type { AudioChannelMode, AvcConfig, PesPacket } from '../models/media'
import { AudioStreamDecoder } from './audioDecoder'
import type { AudioDecoderConfigInput } from './audioDecoder'
import { CaptionRenderer } from './caption'
import { AvSync, SyncDecision, microsToPts90k, pts90kToMicros } from './avSync'
import { VideoStreamDecoder, isKeyframe } from './videoDecoder'
import type { VideoDecoderConfigInput } from './videoDecoder'
import { AdtsAssembler, splitAvcAccessUnits } from './elementaryStream'

export interface OneSegPlayerOptions {
  audioContext?: AudioContext
  onError?: (error: Error) => void
  /** A/V sync render window in seconds. */
  toleranceSec?: number
  /** Playback jitter buffer depth in seconds; packets are held this long before decoding. */
  bufferSec?: number
  /** Wall clock in seconds; overridable for tests. */
  clock?: () => number
}

export interface PlayerStats {
  videoSamples: number
  audioSamples: number
  videoFramesDecoded: number
  audioBuffersQueued: number
  dropped: number
  /** Raw PES PTS of the most recent packet, in 90 kHz units. */
  lastPts: number | null
  /** PES packets still waiting in the jitter buffer. */
  bufferedPes: number
}

const DEFAULT_VIDEO_CONFIG: VideoDecoderConfigInput = { codec: 'avc1.42E01E' }
const MAX_PENDING_FRAMES = 8
const CAPTURE_FPS = 30

interface BufferedPes {
  packet: PesPacket
  receivedAt: number
}

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
  private readonly captions = new CaptionRenderer()
  private subtitlesEnabled = false
  private readonly avSync: AvSync
  private readonly bufferSec: number
  private readonly now: () => number
  private readonly pesQueue: BufferedPes[] = []
  private queueTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pending: VideoFrame[] = []
  private drainScheduled = false
  private videoConfig: AvcConfig | VideoDecoderConfigInput | null = null
  private audioConfig: AudioDecoderConfigInput | null = null
  private lastPts: number | null = null
  private readonly adts = new AdtsAssembler()
  private pendingVideo: PesPacket | null = null
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
    this.bufferSec = Math.max(0, options.bufferSec ?? 0)
    this.now = options.clock ?? (() => performance.now() / 1000)

    this.videoDecoder = new VideoStreamDecoder({
      onFrame: (frame) => this.onVideoFrame(frame),
      onError: options.onError,
    })
    this.audioDecoder = new AudioStreamDecoder({
      ...(options.audioContext ? { audioContext: options.audioContext } : {}),
      onError: options.onError,
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
      bufferedPes: this.pesQueue.length,
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
    if (this.bufferSec <= 0) {
      this.routePes(packet)
      return
    }
    this.pesQueue.push({ packet, receivedAt: this.now() })
    this.scheduleQueueDrain()
  }

  private routePes(packet: PesPacket): void {
    if (packet.kind === 'video') {
      this.counters.videoSamples++
      if (packet.pts !== undefined) this.lastPts = packet.pts
      if (!this.videoConfig) this.configureVideo(DEFAULT_VIDEO_CONFIG)
      const previous = this.pendingVideo
      this.pendingVideo = packet
      if (previous) {
        const units = splitAvcAccessUnits(previous.data)
        const start = pts90kToMicros(previous.pts ?? 0)
        const duration = pts90kToMicros((packet.pts ?? 0) - (previous.pts ?? 0))
        const step = duration > 0 && duration < 2_000_000 ? duration / units.length : 1_000_000 / 15
        for (let i = 0; i < units.length; i++) {
          this.videoDecoder.pushSample(units[i], start + i * step, isKeyframe(units[i]))
        }
      }
    } else if (packet.kind === 'caption') {
      if (this.subtitlesEnabled) this.captions.update(packet.data)
    } else if (packet.kind === 'audio') {
      this.counters.audioSamples++
      if (packet.pts !== undefined) this.lastPts = packet.pts
      for (const frame of this.adts.push(packet.data, pts90kToMicros(packet.pts ?? 0))) {
        if (
          !this.audioConfig ||
          this.audioConfig.sampleRate !== frame.sampleRate ||
          this.audioConfig.numberOfChannels !== frame.numberOfChannels ||
          this.audioConfig.codec !== frame.codec
        ) {
          this.configureAudio({
            codec: frame.codec,
            sampleRate: frame.sampleRate,
            numberOfChannels: frame.numberOfChannels,
          })
        }
        this.audioDecoder.pushSample(frame.data, frame.timestamp)
      }
    }
  }

  private scheduleQueueDrain(): void {
    if (this.queueTimer !== null) return
    const oldest = this.pesQueue[0]
    if (!oldest) return
    const waitMs = Math.max(0, (oldest.receivedAt + this.bufferSec - this.now()) * 1000)
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null
      this.drainQueue()
    }, waitMs)
  }

  private drainQueue(): void {
    const cutoff = this.now() - this.bufferSec
    while (this.pesQueue.length > 0 && this.pesQueue[0].receivedAt <= cutoff) {
      const entry = this.pesQueue.shift()
      if (entry) this.routePes(entry.packet)
    }
    if (this.pesQueue.length > 0) this.scheduleQueueDrain()
  }

  private clearQueue(): void {
    if (this.queueTimer !== null) {
      clearTimeout(this.queueTimer)
      this.queueTimer = null
    }
    this.pesQueue.length = 0
  }

  setMuted(muted: boolean): void {
    this.audioDecoder.setMuted(muted)
    if (!muted) this.audioDecoder.resume()
  }

  setAudioChannel(mode: AudioChannelMode): void {
    this.audioDecoder.setChannelMode(mode)
  }

  setSubtitlesEnabled(enabled: boolean): void {
    this.subtitlesEnabled = enabled
    if (!enabled) this.captions.clear()
  }

  resume(): void {
    this.audioDecoder.resume()
  }

  /** Flush decoders and the sync clock; used for LIVE recovery. */
  reset(): void {
    this.clearQueue()
    this.adts.reset()
    this.pendingVideo = null
    this.avSync.reset()
    this.videoDecoder.reset()
    this.audioDecoder.reset()
    this.captions.clear()
    this.clearPending()
  }

  close(): void {
    this.clearQueue()
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
        if (this.subtitlesEnabled) this.captions.draw(context, width, height)
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
