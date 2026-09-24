import { openSidebar } from '../../app/navigation'
import styles from './MenuButton.module.css'

export interface MenuButtonProps {
  className?: string
}

export function MenuButton({ className }: MenuButtonProps) {
  return (
    <button
      type="button"
      aria-label="メニューを開く"
      className={[styles.button, className].filter(Boolean).join(' ')}
      onClick={openSidebar}
    >
      &gt;
    </button>
  )
}
