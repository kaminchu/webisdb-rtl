/**
 * Channel-scan orchestration (要件定義書 16). Kept free of React so the loop is
 * unit-testable: the hook injects store-backed dependencies and a persist callback.
 */
import type { Service } from '../models'
import { channelToFrequencyHz, UHF_CHANNEL_MAX, UHF_CHANNEL_MIN } from '../models/channel'
import {
  createMemoryKeyValueStore,
  openKeyValueStore,
  ScanResultRepository,
  type KeyValueStore,
  type ScanResult,
} from '../storage'
import { receiverController } from './receiverController'
import type { AppState } from './store'
import { store } from './store'
import { receivedServices, receivedTransportStreamId } from './serviceInfo'

const PROBE_INTERVAL_MS = 150

export interface ScanProgress {
  /** 1-based index of the channel being scanned. */
  current: number
  total: number
  channel: number
}

export interface ScanChannelSnapshot {
  locked: boolean
  signalLevelDb: number | null
  cnDb: number | null
  merDb: number | null
  transportStreamId: number | null
  services: Service[]
}

export interface ScanChannelResult {
  physicalChannel: number
  frequency: number
  scannedAt: Date
  succeeded: boolean
  signalLevelDb: number | null
  cnDb: number | null
  merDb: number | null
  transportStreamId: number | null
  services: Service[]
}

export interface ScanRunOptions {
  from?: number
  to?: number
  /** Maximum time to acquire transmission and service information per channel. */
  timeoutMs?: number
  /** Extra settle delay between channels. */
  settleMs?: number
}

export interface ScanDependencies {
  tune(channel: number): Promise<void>
  probe(channel: number, timeoutMs: number): Promise<ScanChannelSnapshot>
  persist(results: ScanChannelResult[]): Promise<void>
  onProgress?(progress: ScanProgress): void
  onResult?(result: ScanChannelResult): void
  isCancelled?(): boolean
  delay?(ms: number): Promise<void>
}

export interface StoreScanDependencyOptions {
  persist(results: ScanChannelResult[]): Promise<void>
  onProgress?(progress: ScanProgress): void
  onResult?(result: ScanChannelResult): void
  isCancelled?(): boolean
}

export function emptyScanSnapshot(): ScanChannelSnapshot {
  return {
    locked: false,
    signalLevelDb: null,
    cnDb: null,
    merDb: null,
    transportStreamId: null,
    services: [],
  }
}

/** Inclusive, clamped list of physical channels to scan. */
export function buildScanChannels(from = UHF_CHANNEL_MIN, to = UHF_CHANNEL_MAX): number[] {
  const start = Math.max(UHF_CHANNEL_MIN, Math.min(from, to))
  const end = Math.min(UHF_CHANNEL_MAX, Math.max(from, to))
  const channels: number[] = []
  for (let channel = start; channel <= end; channel++) channels.push(channel)
  return channels
}

export function snapshotToResult(
  channel: number,
  snapshot: ScanChannelSnapshot,
  scannedAt: Date = new Date(),
): ScanChannelResult {
  return {
    physicalChannel: channel,
    frequency: channelToFrequencyHz(channel),
    scannedAt,
    succeeded: snapshot.services.length > 0,
    signalLevelDb: snapshot.signalLevelDb,
    cnDb: snapshot.cnDb,
    merDb: snapshot.merDb,
    transportStreamId: snapshot.transportStreamId,
    services: snapshot.services,
  }
}

export function readScanSnapshot(state: AppState): ScanChannelSnapshot {
  const quality = state.receiver.stats.quality
  return {
    locked: state.diagnostics.tmcc?.locked ?? false,
    signalLevelDb: quality.signalLevelDb,
    cnDb: quality.cnDb,
    merDb: quality.merDb,
    transportStreamId: receivedTransportStreamId(state.diagnostics),
    services: receivedServices(state.diagnostics),
  }
}

function isBetterSnapshot(candidate: ScanChannelSnapshot, current: ScanChannelSnapshot): boolean {
  if (candidate.services.length !== current.services.length) {
    return candidate.services.length > current.services.length
  }
  if ((candidate.transportStreamId !== null) !== (current.transportStreamId !== null))
    return candidate.transportStreamId !== null
  if (candidate.locked !== current.locked) return candidate.locked
  return (candidate.signalLevelDb ?? -Infinity) > (current.signalLevelDb ?? -Infinity)
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * TMCC precedes FEC warm-up and PSI/SI acquisition, so lock alone cannot end a scan.
 */
export async function probeChannel(
  timeoutMs: number,
  isCancelled?: () => boolean,
  readState: () => AppState = () => store.getState(),
  delay: (ms: number) => Promise<void> = defaultDelay,
): Promise<ScanChannelSnapshot> {
  const deadline = Date.now() + timeoutMs
  let best = emptyScanSnapshot()
  for (;;) {
    if (isCancelled?.()) return best
    const state = readState()
    const snapshot = readScanSnapshot(state)
    if (
      snapshot.services.length > 0 &&
      snapshot.transportStreamId !== null &&
      state.diagnostics.sdt
    )
      return snapshot
    if (isBetterSnapshot(snapshot, best)) best = snapshot
    if (Date.now() >= deadline) return best
    await delay(PROBE_INTERVAL_MS)
  }
}

export async function runChannelScan(
  channels: number[],
  deps: ScanDependencies,
  options: ScanRunOptions = {},
): Promise<ScanChannelResult[]> {
  const timeoutMs = options.timeoutMs ?? 8000
  const settleMs = options.settleMs ?? 0
  const total = channels.length
  const results: ScanChannelResult[] = []

  for (let index = 0; index < total; index++) {
    if (deps.isCancelled?.()) break
    const channel = channels[index]
    deps.onProgress?.({ current: index + 1, total, channel })
    await deps.tune(channel)
    if (deps.isCancelled?.()) break
    const snapshot = await deps.probe(channel, timeoutMs)
    const result = snapshotToResult(channel, snapshot)
    results.push(result)
    deps.onResult?.(result)
    if (settleMs > 0 && index < total - 1 && deps.delay) await deps.delay(settleMs)
  }

  await deps.persist(results)
  return results
}

export function createStoreScanDependencies(options: StoreScanDependencyOptions): ScanDependencies {
  return {
    tune: (channel) => receiverController.tunePhysicalChannel(channel),
    probe: (_channel, timeoutMs) => probeChannel(timeoutMs, options.isCancelled),
    persist: options.persist,
    onProgress: options.onProgress,
    onResult: options.onResult,
    isCancelled: options.isCancelled,
    delay: defaultDelay,
  }
}

// --- persistence ---------------------------------------------------------

export function toStoredScanResult(result: ScanChannelResult): ScanResult {
  return {
    physicalChannel: result.physicalChannel,
    frequency: result.frequency,
    scannedAt: result.scannedAt,
    succeeded: result.succeeded,
    serviceCount: result.services.length,
    signalLevelDb: result.signalLevelDb,
    transportStreamId: result.transportStreamId,
    services: result.services,
    cnDb: result.cnDb,
    merDb: result.merDb,
  }
}

export function fromStoredScanResult(record: ScanResult): ScanChannelResult {
  return {
    physicalChannel: record.physicalChannel,
    frequency: record.frequency,
    scannedAt: record.scannedAt instanceof Date ? record.scannedAt : new Date(record.scannedAt),
    succeeded: record.succeeded,
    signalLevelDb: record.signalLevelDb,
    cnDb: record.cnDb ?? null,
    merDb: record.merDb ?? null,
    transportStreamId: record.transportStreamId ?? null,
    services: record.services ?? [],
  }
}

export const SCAN_RESULTS_STORAGE_KEY = 'webisdb-rtl.scanResults'

export function saveScanResultsToLocalStorage(results: ScanResult[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SCAN_RESULTS_STORAGE_KEY, JSON.stringify(results))
  } catch {
    // storage unavailable or quota exceeded
  }
}

export function loadScanResultsFromLocalStorage(): ScanResult[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(SCAN_RESULTS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Array<ScanResult & { scannedAt: string }>
    if (!Array.isArray(parsed)) return []
    return parsed.map((record) => ({ ...record, scannedAt: new Date(record.scannedAt) }))
  } catch {
    return []
  }
}

let appStorePromise: Promise<KeyValueStore> | null = null

/**
 * Shared, lazily opened IndexedDB store. Falls back to a process-wide in-memory
 * store when IndexedDB is unavailable, so reads and writes still see each other.
 */
export function openAppKeyValueStore(): Promise<KeyValueStore> {
  appStorePromise ??= openKeyValueStore().catch(() => createMemoryKeyValueStore())
  return appStorePromise
}

export async function loadStoredScanResults(): Promise<ScanResult[]> {
  try {
    const kv = await openKeyValueStore()
    try {
      return await new ScanResultRepository(kv).getAll()
    } finally {
      kv.close()
    }
  } catch {
    return loadScanResultsFromLocalStorage()
  }
}

export async function persistScanResults(results: ScanChannelResult[]): Promise<void> {
  const stored = results.map(toStoredScanResult)
  try {
    const kv = await openKeyValueStore()
    try {
      await new ScanResultRepository(kv).putResults(stored)
    } finally {
      kv.close()
    }
  } catch {
    saveScanResultsToLocalStorage(stored)
  }
}
