import { useEffect } from 'react'
import { useStore, Screen } from './app/store'
import { navigate, startHashNavigation } from './app/navigation'
import { loadStoredScanResults } from './app/scanController'
import { loadSettings } from './storage/settings'
import { AppSidebar } from './features/shell/AppSidebar'
import styles from './App.module.css'
import { WatchScreen } from './features/watch/WatchScreen'
import { EpgScreen } from './features/epg/EpgScreen'
import { SettingsScreen } from './features/settings/SettingsScreen'

function CurrentScreen({ screen }: { screen: Screen }) {
  switch (screen) {
    case Screen.Epg:
      return <EpgScreen />
    case Screen.Settings:
      return <SettingsScreen />
    case Screen.Watch:
    default:
      return <WatchScreen />
  }
}

export function App() {
  const screen = useStore((s) => s.screen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)

  useEffect(() => {
    const dispose = startHashNavigation()
    void (async () => {
      const settings = loadSettings()
      if (settings.lastRegionId) {
        const results = await loadStoredScanResults()
        if (results.length > 0) return
      }
      navigate(Screen.Settings)
    })()
    return dispose
  }, [])

  return (
    <div className={styles.app}>
      <AppSidebar open={sidebarOpen} />
      <main className={styles.main}>
        <CurrentScreen screen={screen} />
      </main>
    </div>
  )
}
