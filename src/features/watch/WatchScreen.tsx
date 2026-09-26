import { useEffect, useRef, useState } from 'react'
import { openSidebar } from '../../app/navigation'
import { reportError } from '../../app/notifications'
import { receiverController } from '../../app/receiverController'
import { useStore } from '../../app/store'
import { OneSegPlayer } from '../../media'
import type { AudioChannelMode } from '../../models/media'
import { loadSettings, saveSettings } from '../../storage/settings'
import { CompactGuide } from './CompactGuide'
import { DebugOverlay } from './DebugOverlay'
import { PlayerView } from './PlayerView'
import { WatchControls } from './WatchControls'
import { useDockedGuide } from './useDockedGuide'
import styles from './WatchScreen.module.css'

export function WatchScreen() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const playerRef = useRef<OneSegPlayer | null>(null)
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [guideOnTop, setGuideOnTop] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [initialSettings] = useState(loadSettings)
  const [audioChannel, setAudioChannel] = useState<AudioChannelMode>(
    initialSettings.ui.audioChannel,
  )
  const [subtitles, setSubtitles] = useState(initialSettings.ui.subtitles)
  const [showDebug, setShowDebug] = useState(initialSettings.debug.showOverlay)
  const docked = useDockedGuide()

  const sourceKind = useStore((s) => s.receiver.sourceKind)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const player = new OneSegPlayer(canvas, {
      onError: (error) => reportError('player', error),
      bufferSec: initialSettings.bufferSeconds,
    })
    playerRef.current = player
    receiverController.setPlayer(player)
    player.setAudioChannel(initialSettings.ui.audioChannel)
    player.setSubtitlesEnabled(initialSettings.ui.subtitles)
    return () => {
      player.close()
      playerRef.current = null
      receiverController.setPlayer(null)
    }
  }, [initialSettings])

  const connected = sourceKind !== 'none'

  const connect = async () => {
    if (connecting) return
    setConnecting(true)
    try {
      await receiverController.connectRtlSdr()
    } catch (cause) {
      reportError('connect', cause)
    } finally {
      setConnecting(false)
    }
  }

  const onStageClick = () => {
    if (!connected) {
      void connect()
      return
    }
    const next = !overlayOpen
    setOverlayOpen(next)
    if (next) setGuideOnTop(false)
  }

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

  const toggleDebug = () => {
    const next = !showDebug
    setShowDebug(next)
    saveSettings({ debug: { showOverlay: next } })
  }

  return (
    <div
      className={styles.root}
      onPointerDown={() => playerRef.current?.resume()}
      onKeyDown={() => playerRef.current?.resume()}
    >
      <div className={styles.stage} onClick={onStageClick}>
        <PlayerView canvasRef={canvasRef} connected={connected} connecting={connecting} />

        {showDebug && (
          <DebugOverlay
            audioChannel={audioChannel}
            subtitles={subtitles}
            settings={initialSettings}
          />
        )}

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
              debugOverlay={showDebug}
              className={guideOnTop ? undefined : styles.controlsFront}
              onActivate={() => setGuideOnTop(false)}
              onAudioChange={changeAudio}
              onToggleSubtitles={toggleSubtitles}
              onToggleDebugOverlay={toggleDebug}
            />

            {!docked && (
              <div
                className={
                  guideOnTop ? `${styles.guideLayer} ${styles.guideLayerFront}` : styles.guideLayer
                }
                onPointerDown={() => setGuideOnTop(true)}
                onClick={(event) => event.stopPropagation()}
              >
                <CompactGuide />
              </div>
            )}
          </div>
        )}
      </div>

      {docked && (
        <div className={styles.dockedGuide}>
          <CompactGuide />
        </div>
      )}
    </div>
  )
}
