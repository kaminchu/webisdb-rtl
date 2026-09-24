import { useEffect } from 'react'
import { useStore, Screen } from './app/store'
import { SCREENS } from './app/screens'
import { navigate, startHashNavigation } from './app/navigation'
import styles from './App.module.css'
import { WatchScreen } from './features/watch/WatchScreen'
import { EpgScreen } from './features/epg/EpgScreen'
import { ScanScreen } from './features/scan/ScanScreen'
import { DebugScreen } from './features/debug/DebugScreen'
import { SettingsScreen } from './features/settings/SettingsScreen'

function CurrentScreen({ screen }: { screen: Screen }) {
  switch (screen) {
    case Screen.Epg:
      return <EpgScreen />
    case Screen.Scan:
      return <ScanScreen />
    case Screen.Debug:
      return <DebugScreen />
    case Screen.Settings:
      return <SettingsScreen />
    case Screen.Watch:
    default:
      return <WatchScreen />
  }
}

export function App() {
  const screen = useStore((s) => s.screen)
  const receiverState = useStore((s) => s.receiver.state)
  const label = useStore((s) => s.receiver.label)

  useEffect(() => startHashNavigation(), [])

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo}>📺</span>
          <span>WebISDB-RTL</span>
        </div>
        <nav className={styles.nav}>
          {SCREENS.map((meta) => (
            <button
              key={meta.id}
              type="button"
              title={meta.description}
              className={[styles.navItem, screen === meta.id ? styles.navActive : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => navigate(meta.id)}
            >
              {meta.label}
            </button>
          ))}
        </nav>
        <div className={styles.status} data-state={receiverState}>
          <span className={styles.dot} />
          {label}
        </div>
      </header>
      <main className={styles.main}>
        <CurrentScreen screen={screen} />
      </main>
    </div>
  )
}
