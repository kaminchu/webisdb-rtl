import { describe, expect, it } from 'vitest'
import type { ConfiguredChannel } from '../../models'
import {
  buildEpgFetchChannels,
  runEpgFetch,
  type EpgFetchDependencies,
  type EpgFetchProgress,
} from './epgFetchController'

function channel(physicalChannel: number): ConfiguredChannel {
  return { physicalChannel }
}

describe('buildEpgFetchChannels', () => {
  it('sorts and de-duplicates the configured channels', () => {
    expect(buildEpgFetchChannels([channel(19), channel(13), channel(19), channel(15)])).toEqual([
      13, 15, 19,
    ])
  })

  it('returns an empty list when nothing is configured', () => {
    expect(buildEpgFetchChannels([])).toEqual([])
  })
})

interface FetchHarness {
  deps: EpgFetchDependencies
  tuned: number[]
  started: EpgFetchProgress[]
  done: EpgFetchProgress[]
  delays: number[]
}

function makeDeps(overrides: Partial<EpgFetchDependencies> = {}): FetchHarness {
  const tuned: number[] = []
  const started: EpgFetchProgress[] = []
  const done: EpgFetchProgress[] = []
  const delays: number[] = []
  const deps: EpgFetchDependencies = {
    channels: () => [channel(19), channel(13)],
    tune: async (value) => {
      tuned.push(value)
    },
    onChannelStart: (progress) => started.push(progress),
    onChannelDone: (progress) => done.push(progress),
    delay: async (ms) => {
      delays.push(ms)
    },
    ...overrides,
  }
  return { deps, tuned, started, done, delays }
}

describe('runEpgFetch', () => {
  it('tunes every channel, waits and marks the replacement request', async () => {
    const { deps, tuned, started, done, delays } = makeDeps()
    await runEpgFetch(deps, { perChannelMs: 250 })

    expect(tuned).toEqual([13, 19])
    expect(started.map((value) => value.current)).toEqual([1, 2])
    expect(started[0]).toEqual({ current: 1, total: 2, channel: 13 })
    expect(done.map((value) => value.channel)).toEqual([13, 19])
    expect(delays).toEqual([250, 250])
  })

  it('stops before tuning once cancelled', async () => {
    const { deps, tuned } = makeDeps({ isCancelled: () => true })
    await runEpgFetch(deps, { perChannelMs: 10 })
    expect(tuned).toEqual([])
  })

  it('does nothing when no channels are configured', async () => {
    const { deps, tuned, started } = makeDeps({ channels: () => [] })
    await runEpgFetch(deps, { perChannelMs: 10 })
    expect(tuned).toEqual([])
    expect(started).toEqual([])
  })
})
