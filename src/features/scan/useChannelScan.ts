import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildScanChannels,
  createStoreScanDependencies,
  fromStoredScanResult,
  loadStoredScanResults,
  persistScanResults,
  runChannelScan,
  type ScanChannelResult,
  type ScanProgress,
  type ScanRunOptions,
} from '../../app/scanController'

export interface ChannelScanState {
  running: boolean
  progress: ScanProgress | null
  results: ScanChannelResult[]
  error: string | null
  start(options?: ScanRunOptions): Promise<void>
  cancel(): void
}

export function useChannelScan(): ChannelScanState {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [results, setResults] = useState<ScanChannelResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  const runningRef = useRef(false)

  useEffect(() => {
    let active = true
    void loadStoredScanResults()
      .then((stored) => {
        if (!active || runningRef.current) return
        setResults(stored.map(fromStoredScanResult))
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  const start = useCallback(async (options: ScanRunOptions = {}) => {
    if (runningRef.current) return
    runningRef.current = true
    cancelledRef.current = false
    setRunning(true)
    setError(null)
    setResults([])
    setProgress(null)

    const channels = buildScanChannels(options.from, options.to)
    try {
      const deps = createStoreScanDependencies({
        persist: persistScanResults,
        onProgress: (next) => setProgress(next),
        onResult: (result) => setResults((prev) => [...prev, result]),
        isCancelled: () => cancelledRef.current,
      })
      await runChannelScan(channels, deps, options)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      runningRef.current = false
      setRunning(false)
      setProgress(null)
    }
  }, [])

  const cancel = useCallback(() => {
    cancelledRef.current = true
  }, [])

  return { running, progress, results, error, start, cancel }
}
