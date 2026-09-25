import type { AudioChannelMode } from '../../models/media'
import styles from './WatchControls.module.css'

const AUDIO_MODES: { mode: AudioChannelMode; label: string }[] = [
  { mode: 'stereo', label: 'ステレオ' },
  { mode: 'main', label: '主音声' },
  { mode: 'sub', label: '副音声' },
]

export interface WatchControlsProps {
  audioChannel: AudioChannelMode
  subtitles: boolean
  debugOverlay: boolean
  onAudioChange(mode: AudioChannelMode): void
  onToggleSubtitles(): void
  onToggleDebugOverlay(): void
}

export function WatchControls({
  audioChannel,
  subtitles,
  debugOverlay,
  onAudioChange,
  onToggleSubtitles,
  onToggleDebugOverlay,
}: WatchControlsProps) {
  return (
    <div className={styles.controls} onClick={(event) => event.stopPropagation()}>
      <div className={styles.group}>
        <span className={styles.caption}>音声</span>
        <div className={styles.options}>
          {AUDIO_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              className={audioChannel === mode ? styles.optionActive : styles.option}
              onClick={() => onAudioChange(mode)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.group}>
        <span className={styles.caption}>字幕</span>
        <button
          type="button"
          className={subtitles ? styles.optionActive : styles.option}
          aria-pressed={subtitles}
          onClick={onToggleSubtitles}
        >
          {subtitles ? '表示する' : '表示しない'}
        </button>
      </div>
      <div className={styles.group}>
        <span className={styles.caption}>デバッグ</span>
        <button
          type="button"
          className={debugOverlay ? styles.optionActive : styles.option}
          aria-pressed={debugOverlay}
          onClick={onToggleDebugOverlay}
        >
          {debugOverlay ? '表示する' : '表示しない'}
        </button>
      </div>
    </div>
  )
}
