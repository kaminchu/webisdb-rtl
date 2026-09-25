import type { AudioChannelMode, AvcConfig, PesPacket } from '../models/media'
import { AudioStreamDecoder } from './audioDecoder'
import type { AudioDecoderConfigInput } from './audioDecoder'
import { CaptionRenderer } from './caption'
import { AvSync, SyncDecision, microsToPts90k, pts90kToMicros } from './avSync'
import { VideoStreamDecoder, isKeyframe } from './videoDecoder'
import type { VideoDecoderConfigInput } from './videoDecoder'
import { AdtsAssembler, splitAvcAccessUnits } from './elementaryStream'
import {
  AvcParameterSetCollector,
  buildAvcDecoderConfigurationRecord,
  codecStringFromParameterSets,
} from './avc'

export interface OneSegPlayerOptions {
  audioContext?: AudioContext
  onError?: (error: Error) => void
  /** A/V sync render window in seconds. */
  toleranceSec?: number
  /** Playback delay in seconds, used to absorb packet arrival jitter. */
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
const MAX_PENDING_FRAMES = 64
// Bound the jitter buffer so a stalled master clock cannot grow it without limit.
const MAX_BUFFERED_PES = 1024
// Video access-unit timing needs the following PES; decode before its PTS is due.
const DECODE_AHEAD_SEC = 1
const CAPTURE_FPS = 30
// Detect a frozen video pipeline: packets keep arriving but no frame is drawn.
const STALL_CHECK_SEC = 2.5
// Large PTS steps in either direction include dropouts and the 33-bit PTS wrap.
const MAX_PTS_JUMP_SEC = 2

interface BufferedPes {
  packet: PesPacket
  ptsSec: number
}

function isCanvasElement(
  element: HTMLVideoElement | HTMLCanvasElement,
): element is HTMLCanvasElement {
  return typeof (element as HTMLCanvasElement).getContext === 'function'
}

function audioConfigMatches(a: AudioDecoderConfigInput, b: AudioDecoderConfigInput): boolean {
  return (
    a.codec === b.codec &&
    a.sampleRate === b.sampleRate &&
    a.numberOfChannels === b.numberOfChannels
  )
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
  private drainHandle: number | ReturnType<typeof setTimeout> | null = null
  private drainUsesAnimationFrame = false
  private videoConfig: AvcConfig | VideoDecoderConfigInput | null = null
  private avcDescriptionConfigured = false
  private readonly avcParameterSets = new AvcParameterSetCollector()
  private audioConfig: AudioDecoderConfigInput | null = null
  private lastPts: number | null = null
  private readonly adts = new AdtsAssembler()
  private pendingVideo: PesPacket | null = null
  private lastIncomingPtsSec: { video?: number; audio?: number } = {}
  private incomingVideoSamples = 0
  private stallCheckAt: number | null = null
  private stallFrames = 0
  private stallVideoSamples = 0
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
      playbackTime: () => this.avSync.now(),
      maxQueueSec: DECODE_AHEAD_SEC + 1,
      onBufferQueued: () => {
        this.counters.audioBuffersQueued++
      },
    })
    this.avSync = new AvSync({
      wallClock: this.now,
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
    this.avcDescriptionConfigured = 'description' in config && config.description !== undefined
    this.videoDecoder.configure(config)
  }

  /** Install the AAC configuration extracted from the PMT descriptor. */
  configureAudio(config: AudioDecoderConfigInput): void {
    this.audioConfig = config
    this.audioDecoder.configure(config)
  }

  pushPes(packet: PesPacket): void {
    if (packet.pts !== undefined && (packet.kind === 'video' || packet.kind === 'audio')) {
      const previous = this.lastIncomingPtsSec[packet.kind]
      if (previous !== undefined && Math.abs(packet.pts / 90_000 - previous) > MAX_PTS_JUMP_SEC) {
        this.recover()
        this.avSync.anchor(packet.pts, 0)
      }
      this.lastIncomingPtsSec[packet.kind] = packet.pts / 90_000
    }
    if (packet.kind === 'video') this.incomingVideoSamples++
    this.checkStall()
    if (
      !this.avSync.anchored &&
      packet.pts !== undefined &&
      (packet.kind === 'video' || packet.kind === 'audio')
    ) {
      this.avSync.anchor(packet.pts, this.bufferSec)
    }
    const ptsSec = packet.pts !== undefined ? packet.pts / 90_000 : this.avSync.now()
    this.pesQueue.push({ packet, ptsSec })
    this.pesQueue.sort((a, b) => a.ptsSec - b.ptsSec)
    if (this.pesQueue.length > MAX_BUFFERED_PES) {
      const excess = this.pesQueue.length - MAX_BUFFERED_PES
      this.pesQueue.splice(0, excess)
      this.counters.dropped += excess
    }
    if (this.queueTimer !== null) clearTimeout(this.queueTimer)
    this.queueTimer = null
    this.drainQueue()
  }

  /**
   * Nudge the decoders and sync clock when video packets keep arriving but no
   * frame has been presented for a while. This recovers from decoder errors and
   * PTS discontinuities without tearing down the configured codecs.
   */
  private checkStall(): void {
    const now = this.now()
    if (this.stallCheckAt === null) {
      this.stallCheckAt = now + this.bufferSec
      this.stallFrames = this.counters.videoFramesDecoded
      this.stallVideoSamples = this.incomingVideoSamples
      return
    }
    if (now - this.stallCheckAt < STALL_CHECK_SEC) return
    const progressed = this.counters.videoFramesDecoded !== this.stallFrames
    const receiving = this.incomingVideoSamples !== this.stallVideoSamples
    this.stallCheckAt = now
    this.stallFrames = this.counters.videoFramesDecoded
    this.stallVideoSamples = this.incomingVideoSamples
    if (!progressed && receiving) this.recover()
  }

  /** Re-key decoders and reset the sync clock while keeping codec config. */
  recover(): void {
    this.clearQueue()
    this.adts.reset()
    this.pendingVideo = null
    this.lastIncomingPtsSec = {}
    this.stallCheckAt = null
    this.avSync.reset()
    this.videoDecoder.reset()
    this.audioDecoder.reset()
    this.clearPending()
  }

  private routePes(packet: PesPacket): void {
    if (packet.kind === 'video') {
      this.counters.videoSamples++
      if (packet.pts !== undefined) this.lastPts = packet.pts
      this.updateVideoConfigFromStream(packet.data)
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
      if (this.subtitlesEnabled) this.captions.update(packet.data, packet.pts)
    } else if (packet.kind === 'audio') {
      this.counters.audioSamples++
      if (packet.pts !== undefined) this.lastPts = packet.pts
      for (const frame of this.adts.push(packet.data, pts90kToMicros(packet.pts ?? 0))) {
        const next: AudioDecoderConfigInput = {
          codec: frame.codec,
          sampleRate: frame.sampleRate,
          numberOfChannels: frame.numberOfChannels,
        }
        if (this.audioConfig && !audioConfigMatches(this.audioConfig, next)) {
          if (!this.audioDecoder.configuredDecoder) {
            // The previous config was rejected; do not retry it on every frame.
            this.audioConfig = next
          } else {
            this.configureAudio(next)
          }
        } else if (!this.audioConfig) {
          this.configureAudio(next)
        }
        this.audioDecoder.pushSample(frame.data, frame.timestamp)
      }
    }
  }

  private updateVideoConfigFromStream(data: Uint8Array): void {
    if (this.avcDescriptionConfigured) return
    if (!this.avcParameterSets.push(data)) return
    const sets = this.avcParameterSets.parameterSets
    if (!sets) return
    this.configureVideo({
      codec: codecStringFromParameterSets(sets),
      description: buildAvcDecoderConfigurationRecord(sets),
    })
  }

  private scheduleQueueDrain(): void {
    if (this.queueTimer !== null) return
    const oldest = this.pesQueue[0]
    if (!oldest) return
    const waitMs = Math.max(
      1,
      Math.min(100, (oldest.ptsSec - DECODE_AHEAD_SEC - this.avSync.now()) * 1000),
    )
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null
      this.drainQueue()
    }, waitMs)
  }

  private drainQueue(): void {
    const cutoff = this.avSync.now() + DECODE_AHEAD_SEC
    while (this.pesQueue.length > 0 && this.pesQueue[0].ptsSec <= cutoff) {
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
    this.lastIncomingPtsSec = {}
    this.stallCheckAt = null
    this.clearQueue()
    this.adts.reset()
    this.pendingVideo = null
    this.videoConfig = null
    this.avcDescriptionConfigured = false
    this.avcParameterSets.reset()
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
    this.pending.push(frame)
    this.pending.sort((a, b) => a.timestamp - b.timestamp)
    if (this.pending.length > MAX_PENDING_FRAMES) {
      this.pending.pop()?.close()
      this.counters.dropped++
    }
    this.scheduleDrain()
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
        if (this.subtitlesEnabled) {
          this.captions.draw(context, width, height, microsToPts90k(frame.timestamp))
        }
      }
      this.counters.videoFramesDecoded++
    } finally {
      frame.close()
    }
  }

  private scheduleDrain(): void {
    if (this.drainHandle !== null) return
    const run = () => {
      this.drainHandle = null
      this.drainPending()
    }
    this.drainUsesAnimationFrame = typeof requestAnimationFrame === 'function'
    this.drainHandle = this.drainUsesAnimationFrame
      ? requestAnimationFrame(run)
      : setTimeout(run, 16)
  }

  private drainPending(): void {
    if (this.pending.length === 0) return
    let due: VideoFrame | null = null
    while (this.pending.length > 0) {
      const frame = this.pending[0]
      const decision = this.avSync.decision(microsToPts90k(frame.timestamp))
      if (decision === SyncDecision.Hold) break
      this.pending.shift()
      if (decision === SyncDecision.Drop) {
        this.counters.dropped++
        frame.close()
      } else {
        if (due) {
          due.close()
          this.counters.dropped++
        }
        due = frame
      }
    }
    if (due) this.drawFrame(due)
    if (this.pending.length > 0) this.scheduleDrain()
  }

  private clearPending(): void {
    if (this.drainHandle !== null) {
      if (this.drainUsesAnimationFrame) cancelAnimationFrame(this.drainHandle as number)
      else clearTimeout(this.drainHandle)
      this.drainHandle = null
    }
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
