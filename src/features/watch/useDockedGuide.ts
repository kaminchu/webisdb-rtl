import { useEffect, useState } from 'react'

const PORTRAIT_MIN_BELOW = 200

/**
 * True when the viewport is portrait and enough room remains below the 16:9
 * video, so the guide can live under the picture instead of overlaying it.
 */
export function useDockedGuide(): boolean {
  const [docked, setDocked] = useState(false)

  useEffect(() => {
    const measure = () => {
      const portrait = window.innerHeight > window.innerWidth
      const videoHeight = window.innerWidth * (9 / 16)
      setDocked(portrait && window.innerHeight - videoHeight >= PORTRAIT_MIN_BELOW)
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', measure)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', measure)
    }
  }, [])

  return docked
}
