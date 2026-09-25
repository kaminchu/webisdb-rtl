import { useEffect } from 'react'
import { store, useStore, Screen } from './app/store'
import { navigate, startHashNavigation } from './app/navigation'
import { receiverController } from './app/receiverController'
import { AppSidebar } from './features/shell/AppSidebar'
import { ErrorToaster } from './components/ErrorToaster'
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
      if (store.getState().configuredChannels.length === 0) {
        navigate(Screen.Settings)
        return
      }
      await receiverController.autoConnectRtlSdr()
    })()
    return dispose
  }, [])

  return (
    <div className={styles.app}>
      <AppSidebar open={sidebarOpen} />
      <main className={styles.main}>
        <CurrentScreen screen={screen} />
      </main>
      <ErrorToaster />
    </div>
  )
}
