import type { Event } from '../../models'
import { genreMajor } from './layout'
import { formatJstTime } from './time'
import styles from './timetable.module.css'

const GENRE_CLASSES = [
  styles.genre0,
  styles.genre1,
  styles.genre2,
  styles.genre3,
  styles.genre4,
  styles.genre5,
  styles.genre6,
  styles.genre7,
  styles.genre8,
  styles.genre9,
  styles.genre10,
  styles.genre11,
  styles.genre12,
  styles.genre13,
  styles.genre14,
  styles.genre15,
]

export interface ProgramBlockProps {
  event: Event
  top: number
  height: number
  running?: boolean
  past?: boolean
  compact?: boolean
  /** When false the block is display-only and its column handles selection. */
  interactive?: boolean
  onClick(): void
}

export function ProgramBlock({
  event,
  top,
  height,
  running = false,
  past = false,
  compact = false,
  interactive = true,
  onClick,
}: ProgramBlockProps) {
  const major = genreMajor(event.genres)
  const genreClass = major >= 0 && major < GENRE_CLASSES.length ? GENRE_CLASSES[major] : ''
  const classes = [
    styles.program,
    genreClass,
    running ? styles.running : '',
    past ? styles.past : '',
    compact ? styles.compact : '',
    interactive ? '' : styles.static,
  ]
    .filter(Boolean)
    .join(' ')

  const body = (
    <>
      <span className={styles.highlight} />
      <span className={styles.content}>
        <span className={styles.time}>{formatJstTime(event.startTime)}</span>
        <span className={styles.title}>{event.title || '（タイトルなし）'}</span>
        {event.description && <span className={styles.description}>{event.description}</span>}
      </span>
    </>
  )

  if (!interactive) {
    return (
      <div className={classes} style={{ top, height }}>
        {body}
      </div>
    )
  }

  return (
    <button
      type="button"
      className={classes}
      style={{ top, height }}
      onClick={onClick}
      title={event.description}
    >
      {body}
    </button>
  )
}
