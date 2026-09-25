import { useCallback, useRef, useState } from 'react'
import {
  createStoreEpgFetchDependencies,
  runEpgFetch,
  type EpgFetchProgress,
  type EpgFetchRunOptions,
} from './epgFetchController'

export interface EpgFetchState {
  running: boolean
  /** Physical channels still waiting for or receiving EIT data. */
  fetching: number[]
  error: string | null
  start(options?: EpgFetchRunOptions): Promise<void>
  cancel(): void
}

export function useEpgFetch(): EpgFetchState {
  const [running, setRunning] = useState(false)
  const [fetching, setFetching] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  const runningRef = useRef(false)

  const start = useCallback(async (options: EpgFetchRunOptions = {}) => {
    if (runningRef.current) return
    runningRef.current = true
    cancelledRef.current = false
    setRunning(true)
    setError(null)
    setFetching([])

    const deps = createStoreEpgFetchDependencies({
      onChannelStart: (progress: EpgFetchProgress) =>
        setFetching((prev) => [...prev, progress.channel]),
      onChannelDone: (progress: EpgFetchProgress) =>
        setFetching((prev) => prev.filter((channel) => channel !== progress.channel)),
      isCancelled: () => cancelledRef.current,
    })

    try {
      await runEpgFetch(deps, options)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      runningRef.current = false
      setRunning(false)
      setFetching([])
    }
  }, [])

  const cancel = useCallback(() => {
    cancelledRef.current = true
  }, [])

  return { running, fetching, error, start, cancel }
}
