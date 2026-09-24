import { describe, expect, it } from 'vitest'
import { channelToFrequencyHz } from '../models/channel'
import type { TmccInfo } from '../models/tmcc'
import type { ScanResult } from '../storage'
import { createInitialState, type AppState } from './store'
import {
  buildScanChannels,
  fromStoredScanResult,
  loadScanResultsFromLocalStorage,
  probeChannel,
  runChannelScan,
  saveScanResultsToLocalStorage,
  snapshotToResult,
  toStoredScanResult,
  type ScanChannelResult,
  type ScanChannelSnapshot,
  type ScanProgress,
} from './scanController'

function lockedSnapshot(signalLevelDb = -30): ScanChannelSnapshot {
  return {
    locked: true,
    signalLevelDb,
    cnDb: 20,
    merDb: 25,
    transportStreamId: 1,
    services: [{ serviceId: 1, name: 'ワンセグ' }],
  }
}

function makeState(options: { locked?: boolean; signalLevelDb?: number | null }): AppState {
  const base = createInitialState()
  const tmcc: TmccInfo | null = options.locked
    ? {
        locked: true,
        mode: 3,
        guardIntervalRatio: 8,
        partialReception: true,
        systemDescriptor: 1,
        layers: { A: null, B: null, C: null },
        frameCount: 0,
      }
    : null
  return {
    ...base,
    diagnostics: { ...base.diagnostics, tmcc },
    receiver: {
      ...base.receiver,
      stats: {
        ...base.receiver.stats,
        quality: {
          ...base.receiver.stats.quality,
          signalLevelDb: options.signalLevelDb ?? null,
        },
      },
    },
  }
}

describe('buildScanChannels', () => {
  it('defaults to the full UHF range', () => {
    const channels = buildScanChannels()
    expect(channels[0]).toBe(13)
    expect(channels[channels.length - 1]).toBe(52)
    expect(channels).toHaveLength(40)
  })

  it('normalizes reversed bounds and clamps out-of-range values', () => {
    expect(buildScanChannels(20, 15)).toEqual([15, 16, 17, 18, 19, 20])
    expect(buildScanChannels(1, 100)).toEqual(buildScanChannels(13, 52))
  })
})

describe('snapshotToResult', () => {
  it('derives frequency and success from the snapshot', () => {
    const result = snapshotToResult(15, lockedSnapshot(-20))
    expect(result.physicalChannel).toBe(15)
    expect(result.frequency).toBe(channelToFrequencyHz(15))
    expect(result.succeeded).toBe(true)
    expect(result.signalLevelDb).toBe(-20)
  })

  it('marks an unlocked channel with no services as not received', () => {
    const result = snapshotToResult(13, {
      locked: false,
      signalLevelDb: null,
      cnDb: null,
      merDb: null,
      transportStreamId: null,
      services: [],
    })
    expect(result.succeeded).toBe(false)
  })
})

describe('runChannelScan', () => {
  it('tunes every channel, reports progress and persists results', async () => {
    const tuned: number[] = []
    const progress: ScanProgress[] = []
    const liveResults: ScanChannelResult[] = []
    let persisted: ScanChannelResult[] = []

    const results = await runChannelScan([13, 15], {
      tune: async (channel) => {
        tuned.push(channel)
      },
      probe: async () => lockedSnapshot(),
      persist: async (values) => {
        persisted = values
      },
      onProgress: (value) => progress.push(value),
      onResult: (value) => liveResults.push(value),
    })

    expect(tuned).toEqual([13, 15])
    expect(progress.map((value) => value.current)).toEqual([1, 2])
    expect(progress[0].total).toBe(2)
    expect(results).toHaveLength(2)
    expect(liveResults).toEqual(results)
    expect(persisted).toEqual(results)
  })

  it('stops early when cancelled', async () => {
    let tuned = 0
    let completed = 0
    const results = await runChannelScan([13, 15, 17], {
      tune: async () => {
        tuned++
      },
      probe: async () => lockedSnapshot(),
      persist: async () => undefined,
      onResult: () => {
        completed++
      },
      isCancelled: () => completed >= 1,
    })

    expect(tuned).toBe(1)
    expect(results).toHaveLength(1)
  })
})

describe('probeChannel', () => {
  it('retains a TMCC lock at the deadline without claiming decoded services', async () => {
    const snapshot = await probeChannel(0, undefined, () =>
      makeState({ locked: true, signalLevelDb: -20 }),
    )
    expect(snapshot.locked).toBe(true)
    expect(snapshot.signalLevelDb).toBe(-20)
    expect(snapshotToResult(19, snapshot).succeeded).toBe(false)
  })

  it('waits beyond TMCC lock for PMT and SDT even when signal power falls', async () => {
    let reads = 0
    const state = makeState({ locked: true, signalLevelDb: -40 })
    state.diagnostics.pmt = {
      programNumber: 32144,
      version: 0,
      pcrPid: 512,
      programInfo: [],
      streams: [],
    }
    state.diagnostics.sdt = {
      transportStreamId: 32258,
      originalNetworkId: 32258,
      version: 0,
      services: [
        { serviceId: 32144, serviceType: 192, serviceName: 'BSNワンセグ', providerName: '' },
      ],
    }
    const result = await probeChannel(
      1000,
      undefined,
      () => (++reads === 1 ? makeState({ locked: true, signalLevelDb: -10 }) : state),
      async () => undefined,
    )
    expect(reads).toBe(2)
    expect(result.transportStreamId).toBe(32258)
    expect(result.services[0].name).toBe('BSNワンセグ')
  })

  it('returns the best snapshot when lock never happens', async () => {
    const snapshot = await probeChannel(0, undefined, () => makeState({ signalLevelDb: -42 }))
    expect(snapshot.locked).toBe(false)
    expect(snapshot.signalLevelDb).toBe(-42)
  })
})

describe('scan result persistence', () => {
  it('round-trips through localStorage', () => {
    const records: ScanResult[] = [
      {
        physicalChannel: 13,
        frequency: channelToFrequencyHz(13),
        scannedAt: new Date('2026-01-01T00:00:00.000Z'),
        succeeded: true,
        serviceCount: 3,
        signalLevelDb: -30,
      },
    ]
    saveScanResultsToLocalStorage(records)
    const loaded = loadScanResultsFromLocalStorage()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].physicalChannel).toBe(13)
    expect(loaded[0].scannedAt).toBeInstanceOf(Date)
    expect(loaded[0].scannedAt.getTime()).toBe(records[0].scannedAt.getTime())
  })

  it('maps between live and stored results', () => {
    const live = snapshotToResult(13, lockedSnapshot())
    const stored = toStoredScanResult(live)
    expect(stored.serviceCount).toBe(1)
    expect(stored.succeeded).toBe(true)

    const round = fromStoredScanResult(stored)
    expect(round.physicalChannel).toBe(13)
    expect(round.frequency).toBe(live.frequency)
    expect(round.scannedAt).toBeInstanceOf(Date)
    expect(round).toEqual(live)
  })
})
