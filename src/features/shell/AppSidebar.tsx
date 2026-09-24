import { useEffect } from 'react'
import { closeSidebar, navigate } from '../../app/navigation'
import { SCREENS } from '../../app/screens'
import { useStore } from '../../app/store'
import styles from './AppSidebar.module.css'

export function AppSidebar({ open }: { open: boolean }) {
  const screen = useStore((s) => s.screen)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSidebar()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <>
      <div
        className={open ? styles.scrimOpen : styles.scrim}
        onClick={closeSidebar}
        aria-hidden="true"
      />
      <aside className={open ? styles.sidebarOpen : styles.sidebar} aria-hidden={!open}>
        <div className={styles.brand}>
          <span className={styles.logo}>📺</span>
          <span>WebISDB-RTL</span>
        </div>
        <nav className={styles.nav}>
          {SCREENS.map((meta) => (
            <button
              key={meta.id}
              type="button"
              className={screen === meta.id ? styles.itemActive : styles.item}
              onClick={() => {
                navigate(meta.id)
                closeSidebar()
              }}
            >
              <span className={styles.itemLabel}>{meta.label}</span>
              <span className={styles.itemDescription}>{meta.description}</span>
            </button>
          ))}
        </nav>
      </aside>
    </>
  )
}
