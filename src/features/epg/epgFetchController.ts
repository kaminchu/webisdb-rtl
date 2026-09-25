/**
 * Full EPG acquisition (要件定義書 21). Tunes each configured channel in turn,
 * lets EIT accumulate through the normal receiver -> TS -> `useEpg` path, then
 * moves on. Kept free of React so the loop is unit-testable; the hook injects
 * store-backed dependencies and progress callbacks.
 */
import type { ConfiguredChannel } from '../../models'
import { receiverController } from '../../app/receiverController'
import { store } from '../../app/store'

export interface EpgFetchProgress {
  /** 1-based index of the channel being fetched. */
  current: number
  total: number
  channel: number
}

export interface EpgFetchRunOptions {
  /** Time to accumulate EIT for each channel. */
  perChannelMs?: number
}

export interface EpgFetchDependencies {
  channels(): ConfiguredChannel[]
  tune(channel: number): Promise<void>
  onChannelStart?(progress: EpgFetchProgress): void
  onChannelDone?(progress: EpgFetchProgress): void
  isCancelled?(): boolean
  delay?(ms: number): Promise<void>
}

export interface StoreEpgFetchOptions {
  onChannelStart?(progress: EpgFetchProgress): void
  onChannelDone?(progress: EpgFetchProgress): void
  isCancelled?(): boolean
}

export const DEFAULT_EPG_FETCH_PER_CHANNEL_MS = 8000

export function buildEpgFetchChannels(channels: ConfiguredChannel[]): number[] {
  const unique = new Set(channels.map((channel) => channel.physicalChannel))
  return [...unique].toSorted((a, b) => a - b)
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runEpgFetch(
  deps: EpgFetchDependencies,
  options: EpgFetchRunOptions = {},
): Promise<void> {
  const perChannelMs = options.perChannelMs ?? DEFAULT_EPG_FETCH_PER_CHANNEL_MS
  const delay = deps.delay ?? defaultDelay
  const channels = buildEpgFetchChannels(deps.channels())
  const total = channels.length

  for (let index = 0; index < total; index++) {
    if (deps.isCancelled?.()) break
    const channel = channels[index]
    const progress = { current: index + 1, total, channel }
    deps.onChannelStart?.(progress)
    await deps.tune(channel)
    if (deps.isCancelled?.()) break
    await delay(perChannelMs)
    deps.onChannelDone?.(progress)
  }
}

export function createStoreEpgFetchDependencies(
  options: StoreEpgFetchOptions,
): EpgFetchDependencies {
  return {
    channels: () => store.getState().configuredChannels,
    tune: (channel) => receiverController.tunePhysicalChannel(channel),
    onChannelStart: options.onChannelStart,
    onChannelDone: options.onChannelDone,
    isCancelled: options.isCancelled,
    delay: defaultDelay,
  }
}
