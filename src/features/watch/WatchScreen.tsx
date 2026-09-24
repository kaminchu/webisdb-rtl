import { useEffect, useRef, useState } from 'react'
import { openSidebar } from '../../app/navigation'
import { receiverController } from '../../app/receiverController'
import { useStore } from '../../app/store'
import { OneSegPlayer } from '../../media'
import type { PlayerStats } from '../../media/player'
import type { AudioChannelMode } from '../../models/media'
import { loadSettings, saveSettings } from '../../storage/settings'
import { DebugScreen } from '../debug/DebugScreen'
import { CompactGuide } from './CompactGuide'
import { PlayerView } from './PlayerView'
import { WatchControls } from './WatchControls'
import { useDockedGuide } from './useDockedGuide'
import styles from './WatchScreen.module.css'

export function WatchScreen() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const playerRef = useRef<OneSegPlayer | null>(null)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [playerStats, setPlayerStats] = useState<PlayerStats | null>(null)
  const [playerError, setPlayerError] = useState<string | null>(null)
  const [audioChannel, setAudioChannel] = useState<AudioChannelMode>(
    () => loadSettings().ui.audioChannel,
  )
  const [subtitles, setSubtitles] = useState(() => loadSettings().ui.subtitles)
  const [showDebug] = useState(() => loadSettings().debug.showOverlay)
  const docked = useDockedGuide()

  const sourceKind = useStore((s) => s.receiver.sourceKind)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const player = new OneSegPlayer(canvas, { onError: (error) => setPlayerError(error.message) })
    playerRef.current = player
    receiverController.setPlayer(player)
    const settings = loadSettings()
    player.setAudioChannel(settings.ui.audioChannel)
    player.setSubtitlesEnabled(settings.ui.subtitles)
    const timer = window.setInterval(() => setPlayerStats(player.stats), 500)
    return () => {
      window.clearInterval(timer)
      player.close()
      playerRef.current = null
      receiverController.setPlayer(null)
    }
  }, [])

  const connected = sourceKind !== 'none'

  const changeAudio = (mode: AudioChannelMode) => {
    setAudioChannel(mode)
    saveSettings({ ui: { audioChannel: mode } })
    playerRef.current?.setAudioChannel(mode)
  }

  const toggleSubtitles = () => {
    const next = !subtitles
    setSubtitles(next)
    saveSettings({ ui: { subtitles: next } })
    playerRef.current?.setSubtitlesEnabled(next)
  }

  return (
    <div
      className={styles.root}
      onPointerDown={() => playerRef.current?.resume()}
      onKeyDown={() => playerRef.current?.resume()}
    >
      <div className={styles.stage} onClick={() => setOverlayOpen((open) => !open)}>
        <PlayerView canvasRef={canvasRef} connected={connected} />

        {overlayOpen && (
          <div
            className={styles.overlay}
            onClick={(event) => {
              event.stopPropagation()
              setOverlayOpen(false)
            }}
          >
            <button
              type="button"
              className={styles.sidebarButton}
              aria-label="メニューを開く"
              onClick={(event) => {
                event.stopPropagation()
                openSidebar()
              }}
            >
              &gt;
            </button>

            <WatchControls
              audioChannel={audioChannel}
              subtitles={subtitles}
              onAudioChange={changeAudio}
              onToggleSubtitles={toggleSubtitles}
            />

            {showDebug && (
              <div className={styles.debugLayer} onClick={(event) => event.stopPropagation()}>
                <DebugScreen />
                <p className={styles.statsLine}>
                  フレーム {playerStats?.videoFramesDecoded ?? 0} / 音声{' '}
                  {playerStats?.audioBuffersQueued ?? 0} / 破棄 {playerStats?.dropped ?? 0}
                </p>
              </div>
            )}

            {!docked && (
              <div className={styles.guideLayer} onClick={(event) => event.stopPropagation()}>
                <CompactGuide onProgramSelect={() => setOverlayOpen(false)} />
              </div>
            )}
          </div>
        )}

        {playerError && <div className={styles.errorLine}>デコードエラー: {playerError}</div>}
      </div>

      {docked && (
        <div className={styles.dockedGuide}>
          <CompactGuide />
        </div>
      )}
    </div>
  )
}
