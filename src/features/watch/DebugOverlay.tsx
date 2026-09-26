import { useEffect, useState } from 'react'
import { receiverController } from '../../app/receiverController'
import { useStore } from '../../app/store'
import type { PlayerStats } from '../../media'
import styles from './DebugOverlay.module.css'

const POLL_MS = 500

function formatDecimal(value: number | null, digits: number, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}${unit}`
}

function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond)) return '—'
  const kb = bytesPerSecond / 1000
  return kb >= 1000 ? `${(kb / 1000).toFixed(2)} MB/s` : `${kb.toFixed(1)} kB/s`
}

export function DebugOverlay() {
  const quality = useStore((s) => s.receiver.stats.quality)
  const throughput = useStore((s) => s.receiver.stats.throughput)
  const buffer = useStore((s) => s.receiver.stats.buffer)
  const [player, setPlayer] = useState<PlayerStats | null>(null)
  const [fps, setFps] = useState(0)

  useEffect(() => {
    let previousFrames = receiverController.playerStats?.videoFramesDecoded ?? 0
    let previousAt = performance.now()
    const tick = () => {
      const stats = receiverController.playerStats
      const now = performance.now()
      if (stats) {
        const elapsed = (now - previousAt) / 1000
        if (elapsed > 0) setFps((stats.videoFramesDecoded - previousFrames) / elapsed)
        previousFrames = stats.videoFramesDecoded
      }
      previousAt = now
      setPlayer(stats)
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className={styles.overlay} aria-hidden="true">
      <div>
        FPS {fps.toFixed(1)} ドロップ {player?.dropped ?? 0}
      </div>
      <div>
        映像 {player?.videoFramesDecoded ?? 0} / 音声 {player?.audioBuffersQueued ?? 0} / PES{' '}
        {player?.bufferedPes ?? 0}
      </div>
      <div>
        信号 {formatDecimal(quality.signalLevelDb, 1, ' dB')} C/N{' '}
        {formatDecimal(quality.cnDb, 1, ' dB')} BER{' '}
        {quality.ber === null ? '—' : quality.ber.toExponential(2)}
      </div>
      <div>
        TS {formatRate(throughput.tsBytesPerSecond)} DSP{' '}
        {(throughput.dspUtilization * 100).toFixed(0)}% RTF {throughput.realTimeFactor.toFixed(2)}
      </div>
      <div>
        前段 {throughput.frontendPath === 'u8-decimator' ? 'decimator' : 'fractional'} / 前処理{' '}
        {throughput.stages.preprocessMsPerSecond.toFixed(1)} 前段{' '}
        {throughput.stages.frontendMsPerSecond.toFixed(1)} 復号{' '}
        {throughput.stages.decoderMsPerSecond.toFixed(1)} ms/s
      </div>
      <div>
        取得 {throughput.acquisitionCount} 回 {throughput.stages.acquisitionMsPerSecond.toFixed(1)}{' '}
        ms/s ロック喪失 {throughput.lockLossCount} 回
      </div>
      {(throughput.stages.gpuBatchMsPerSecond > 0 ||
        throughput.stages.gpuReadbackMsPerSecond > 0) && (
        <div>
          GPU batch {throughput.stages.gpuBatchMsPerSecond.toFixed(1)} readback{' '}
          {throughput.stages.gpuReadbackMsPerSecond.toFixed(1)} ms/s
        </div>
      )}
      <div>
        バッファ {(buffer.occupancy * 100).toFixed(0)}% 遅延{' '}
        {buffer.estimatedDelaySeconds.toFixed(2)}s ドロップ {buffer.droppedSamples.toLocaleString()}
      </div>
    </div>
  )
}
