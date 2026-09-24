/**
 * Validates the bundled channel data under src/data/japan and prints a summary.
 *
 * Usage:
 *   node scripts/fetch-channel-data.ts
 *   node scripts/fetch-channel-data.ts --fetch
 *
 * The --fetch mode only documents the authoritative sources; it never performs
 * network requests so the repository stays buildable offline.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { channelToFrequencyHz } from '../src/models/channel.ts'
import type {
  ChannelDataFile,
  ChannelEntry,
  Region,
  StationEntry,
  Transmitter,
} from '../src/models/region.ts'

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'japan')
const EXPECTED_VERSION = 1

const SOURCES = [
  '総務省 電波利用ホームページ: 周波数の割当て / 放送局免許情報',
  '総務省 各地方総合通信局: 地上デジタルテレビジョン放送局の免許・チャンネル一覧',
  'NHK 各放送局: 地上デジタル放送チャンネル案内',
  '各放送事業者: 公式サイトのチャンネル・送信所案内',
]

function readJson<T>(fileName: string): ChannelDataFile<T> {
  const raw = readFileSync(join(DATA_DIR, fileName), 'utf8')
  return JSON.parse(raw) as ChannelDataFile<T>
}

function fail(message: string): never {
  throw new Error(message)
}

function checkFile<T>(label: string, file: ChannelDataFile<T>): void {
  if (file.version !== EXPECTED_VERSION) fail(`${label}: unsupported version ${file.version}`)
  if (!file.updatedAt) fail(`${label}: missing updatedAt`)
  const ids = new Set<string>()
  for (const item of file.items as Array<{ id: string }>) {
    if (ids.has(item.id)) fail(`${label}: duplicate id ${item.id}`)
    ids.add(item.id)
  }
}

function checkReferences(
  regions: ChannelDataFile<Region>,
  transmitters: ChannelDataFile<Transmitter>,
  channels: ChannelDataFile<ChannelEntry>,
  stations: ChannelDataFile<StationEntry>,
): void {
  const regionIds = new Set(regions.items.map((r) => r.id))
  const transmitterIds = new Set(transmitters.items.map((t) => t.id))
  const channelIds = new Set(channels.items.map((c) => c.id))

  for (const region of regions.items) {
    for (const id of region.transmitterIds) {
      if (!transmitterIds.has(id)) fail(`region ${region.id}: unknown transmitter ${id}`)
    }
  }
  for (const transmitter of transmitters.items) {
    if (!regionIds.has(transmitter.regionId)) {
      fail(`transmitter ${transmitter.id}: unknown region ${transmitter.regionId}`)
    }
    for (const id of transmitter.channelIds) {
      if (!channelIds.has(id)) fail(`transmitter ${transmitter.id}: unknown channel ${id}`)
    }
  }
  for (const channel of channels.items) {
    if (!transmitterIds.has(channel.transmitterId)) {
      fail(`channel ${channel.id}: unknown transmitter ${channel.transmitterId}`)
    }
    const expected = channelToFrequencyHz(channel.physicalChannel)
    if (channel.frequency !== undefined && channel.frequency !== expected) {
      fail(`channel ${channel.id}: frequency ${channel.frequency} != ${expected}`)
    }
  }
  for (const station of stations.items) {
    if (!channelIds.has(station.channelId)) {
      fail(`station ${station.id}: unknown channel ${station.channelId}`)
    }
  }
}

function printFetchHelp(): void {
  console.log('Authoritative sources for updating src/data/japan/*.json:')
  for (const source of SOURCES) console.log(`  - ${source}`)
  console.log('Fetching is intentionally left manual so unstable URLs/HTML are not hardcoded.')
  console.log('')
}

function main(): void {
  if (process.argv.includes('--fetch')) printFetchHelp()

  const regions = readJson<Region>('regions.json')
  const transmitters = readJson<Transmitter>('transmitters.json')
  const channels = readJson<ChannelEntry>('channels.json')
  const stations = readJson<StationEntry>('stations.json')

  checkFile('regions', regions)
  checkFile('transmitters', transmitters)
  checkFile('channels', channels)
  checkFile('stations', stations)
  checkReferences(regions, transmitters, channels, stations)

  console.log('Channel data OK')
  console.log(
    `  regions:      ${regions.items.length} (version ${regions.version}, ${regions.updatedAt})`,
  )
  console.log(`  transmitters: ${transmitters.items.length}`)
  console.log(`  channels:     ${channels.items.length}`)
  console.log(`  stations:     ${stations.items.length}`)
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
