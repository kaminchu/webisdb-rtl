import { useEffect, useRef } from 'react'
import { useStore } from '../../app/store'
import { formatFrequency } from '../../models/channel'
import styles from './ReceiverPanels.module.css'

const BACKGROUND = '#0b1020'
const TRACE = '#4f9dff'
const GRID = '#38456a'
const MUTED = '#9aa6c4'

export function SpectrumView() {
  const bins = useStore((s) => s.spectrum.bins)
  const binHz = useStore((s) => s.spectrum.binHz)
  const centerFrequency = useStore((s) => s.spectrum.centerFrequency)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return

    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
    const width = canvas.clientWidth || 320
    const height = canvas.clientHeight || 140
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)

    context.fillStyle = BACKGROUND
    context.fillRect(0, 0, width, height)

    if (!bins || bins.length < 2) {
      context.fillStyle = MUTED
      context.font = '12px sans-serif'
      context.fillText('スペクトラム未取得', 8, 20)
      return
    }

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const value of bins) {
      if (value < min) min = value
      if (value > max) max = value
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      min = -100
      max = 0
    }
    const range = max - min

    context.strokeStyle = TRACE
    context.lineWidth = 1
    context.beginPath()
    for (let i = 0; i < bins.length; i++) {
      const x = (i / (bins.length - 1)) * width
      const y = height - ((bins[i] - min) / range) * height
      if (i === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.stroke()

    context.strokeStyle = GRID
    context.beginPath()
    context.moveTo(width / 2, 0)
    context.lineTo(width / 2, height)
    context.stroke()
  }, [bins])

  const spanHz = bins && binHz > 0 ? binHz * bins.length : 0

  return (
    <div className={styles.spectrum}>
      <canvas ref={canvasRef} className={styles.spectrumCanvas} aria-label="周波数スペクトラム" />
      <div className={styles.spectrumLabels}>
        <span>{centerFrequency > 0 ? formatFrequency(centerFrequency) : '—'}</span>
        <span>幅 {spanHz > 0 ? formatFrequency(spanHz) : '—'}</span>
      </div>
    </div>
  )
}
