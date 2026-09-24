import { useCallback, useEffect, useMemo, useState } from 'react'
import { receiverController } from '../../app/receiverController'
import { loadStoredScanResults, openAppKeyValueStore } from '../../app/scanController'
import { useStore } from '../../app/store'
import type { ConfiguredChannel, Event, Service } from '../../models'
import { EventRepository, pruneExpiredEvents } from '../../storage'

/** Keep ended programs around briefly so the guide can show the recent past. */
export const EPG_RETENTION_MS = 3 * 60 * 60 * 1000

export interface ChannelGuideEntry {
  physicalChannel: number
  serviceId: number | null
  serviceName: string
  events: Event[]
}

export interface ChannelGuide {
  generatedAt: Date
  rangeStart: Date
  rangeEnd: Date
  entries: ChannelGuideEntry[]
  total: number
}

export interface ChannelGuideOptions {
  hours?: number
  pastHours?: number
  now?: Date
}

function preferEvent(candidate: Event, existing: Event): boolean {
  if (candidate.running !== existing.running) return candidate.running === true
  const candidateUpdated = candidate.updatedAt?.getTime() ?? 0
  const existingUpdated = existing.updatedAt?.getTime() ?? 0
  if (candidateUpdated !== existingUpdated) return candidateUpdated > existingUpdated
  return candidate.title.length > existing.title.length
}

function mergeEvents(events: Event[]): Map<string, Event> {
  const merged = new Map<string, Event>()
  for (const event of events) {
    const key = `${event.serviceId}:${event.eventId}`
    const existing = merged.get(key)
    if (!existing || preferEvent(event, existing)) merged.set(key, event)
  }
  return merged
}

/**
 * Build a channel-centric guide from the configured channels. Channels with no
 * matching events are kept so the guide is usable before EPG data arrives.
 */
export function buildChannelGuide(
  channels: ConfiguredChannel[],
  events: Event[],
  serviceNames: ReadonlyMap<number, string>,
  serviceIdsByChannel: ReadonlyMap<number, number[]>,
  options: ChannelGuideOptions = {},
): ChannelGuide {
  const now = options.now ?? new Date()
  const hours = options.hours ?? 6
  const pastHours = options.pastHours ?? 1
  const rangeStart = new Date(now.getTime() - pastHours * 3_600_000)
  const rangeEnd = new Date(now.getTime() + hours * 3_600_000)
  const merged = mergeEvents(events)

  const entries: ChannelGuideEntry[] = []
  let total = 0
  for (const channel of channels) {
    const ids = new Set<number>()
    if (channel.serviceId !== undefined) ids.add(channel.serviceId)
    for (const id of serviceIdsByChannel.get(channel.physicalChannel) ?? []) ids.add(id)

    const channelEvents: Event[] = []
    for (const event of merged.values()) {
      if (!ids.has(event.serviceId)) continue
      const start = event.startTime.getTime()
      const end = start + event.duration * 1000
      if (end < rangeStart.getTime() || start > rangeEnd.getTime()) continue
      channelEvents.push(event)
    }
    channelEvents.sort((a, b) => a.startTime.getTime() - b.startTime.getTime())

    const primaryId = channel.serviceId ?? [...ids][0] ?? null
    const serviceName =
      channel.name ??
      (primaryId !== null ? serviceNames.get(primaryId) : undefined) ??
      `ch ${channel.physicalChannel}`

    entries.push({
      physicalChannel: channel.physicalChannel,
      serviceId: primaryId,
      serviceName,
      events: channelEvents,
    })
    total += channelEvents.length
  }

  return { generatedAt: now, rangeStart, rangeEnd, entries, total }
}

export interface EpgState {
  guide: ChannelGuide
  loading: boolean
  selectChannel(entry: ChannelGuideEntry): void
  refresh(): void
}

export function useEpg(hours = 6): EpgState {
  const channels = useStore((state) => state.configuredChannels)
  const eit = useStore((state) => state.diagnostics.eit)
  const liveServices = useStore((state) => state.diagnostics.services)
  const liveChannel = useStore((state) => state.receiver.channel)
  const [storedEvents, setStoredEvents] = useState<Event[]>([])
  const [scanServices, setScanServices] = useState<Map<number, Service[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())

  const reload = useCallback(async () => {
    try {
      const store = await openAppKeyValueStore()
      await pruneExpiredEvents(store, new Date(), EPG_RETENTION_MS)
      setStoredEvents(await new EventRepository(store).queryEvents({}))
    } catch {
      // storage unavailable; live EIT is still shown
    }
    try {
      const byChannel = new Map<number, Service[]>()
      for (const result of await loadStoredScanResults()) {
        if (!result.services || result.services.length === 0) continue
        const merged = [...(byChannel.get(result.physicalChannel) ?? []), ...result.services]
        byChannel.set(result.physicalChannel, merged)
      }
      setScanServices(byChannel)
    } catch {
      // scan results unavailable
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await reload()
      setLoading(false)
    })()
  }, [reload])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!eit || eit.events.length === 0) return
    let active = true
    const receivedAt = new Date()
    const events = eit.events.map((event) => ({ ...event, updatedAt: receivedAt }))
    void (async () => {
      try {
        const store = await openAppKeyValueStore()
        await new EventRepository(store).putEvents(events)
      } catch {
        // storage unavailable
      }
      if (active) await reload()
    })()
    return () => {
      active = false
    }
  }, [eit, reload])

  const serviceNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const service of liveServices) map.set(service.serviceId, service.name)
    for (const services of scanServices.values()) {
      for (const service of services)
        if (!map.has(service.serviceId)) map.set(service.serviceId, service.name)
    }
    return map
  }, [liveServices, scanServices])

  const serviceIdsByChannel = useMemo(() => {
    const map = new Map<number, number[]>()
    for (const channel of channels) {
      const ids = new Set<number>()
      if (channel.serviceId !== undefined) ids.add(channel.serviceId)
      for (const service of scanServices.get(channel.physicalChannel) ?? []) {
        ids.add(service.serviceId)
      }
      if (liveChannel === channel.physicalChannel) {
        for (const service of liveServices) ids.add(service.serviceId)
      }
      map.set(channel.physicalChannel, [...ids])
    }
    return map
  }, [channels, scanServices, liveChannel, liveServices])

  const allEvents = useMemo(() => [...storedEvents, ...(eit?.events ?? [])], [storedEvents, eit])

  const guide = useMemo(
    () => buildChannelGuide(channels, allEvents, serviceNames, serviceIdsByChannel, { hours, now }),
    [channels, allEvents, serviceNames, serviceIdsByChannel, hours, now],
  )

  const selectChannel = useCallback((entry: ChannelGuideEntry) => {
    void receiverController.tunePhysicalChannel(entry.physicalChannel)
  }, [])

  const refresh = useCallback(() => {
    setNow(new Date())
    void reload()
  }, [reload])

  return { guide, loading, selectChannel, refresh }
}
