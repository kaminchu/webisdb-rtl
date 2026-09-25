import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { receiverController } from '../../app/receiverController'
import { loadStoredScanResults, openAppKeyValueStore } from '../../app/scanController'
import { useStore } from '../../app/store'
import type { ConfiguredChannel, Event, Service } from '../../models'
import { EventRepository, pruneExpiredEvents, ServiceRepository } from '../../storage'

/** Keep ended programs around briefly so the guide can show the recent past. */
export const EPG_RETENTION_MS = 3 * 60 * 60 * 1000

/**
 * EIT arrives as many small sections per service. Wait until a service stops
 * reporting before replacing its cache wholesale, so programs from other tables
 * are never dropped in between.
 */
export const EIT_SETTLE_MS = 3000

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

function mergeServices(current: Service[], incoming: Service[]): Service[] {
  const byId = new Map(current.map((service) => [service.serviceId, service]))
  for (const service of incoming) byId.set(service.serviceId, service)
  return [...byId.values()]
}

export interface ServiceChannelSources {
  channels: ConfiguredChannel[]
  scanServices: ReadonlyMap<number, Service[]>
  storedServices: Service[]
  liveChannel: number | null
  liveServices: Service[]
}

/** Map each configured channel to the service IDs known from scans, storage, and the live stream. */
export function groupServiceIdsByChannel(sources: ServiceChannelSources): Map<number, number[]> {
  const { channels, scanServices, storedServices, liveChannel, liveServices } = sources
  const map = new Map<number, number[]>()
  for (const channel of channels) {
    const ids = new Set<number>()
    if (channel.serviceId !== undefined) ids.add(channel.serviceId)
    for (const service of scanServices.get(channel.physicalChannel) ?? [])
      ids.add(service.serviceId)
    for (const service of storedServices) {
      if (service.physicalChannel === channel.physicalChannel) ids.add(service.serviceId)
    }
    if (liveChannel === channel.physicalChannel) {
      for (const service of liveServices) ids.add(service.serviceId)
    }
    map.set(channel.physicalChannel, [...ids])
  }
  return map
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
}

export function useEpg(hours = 6): EpgState {
  const channels = useStore((state) => state.configuredChannels)
  const eit = useStore((state) => state.diagnostics.eit)
  const liveServices = useStore((state) => state.diagnostics.services)
  const liveChannel = useStore((state) => state.receiver.channel)
  const [storedEvents, setStoredEvents] = useState<Event[]>([])
  const [storedServices, setStoredServices] = useState<Service[]>([])
  const [scanServices, setScanServices] = useState<Map<number, Service[]>>(new Map())
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())

  const reload = useCallback(async () => {
    try {
      const store = await openAppKeyValueStore()
      await pruneExpiredEvents(store, new Date(), EPG_RETENTION_MS)
      setStoredEvents(await new EventRepository(store).queryEvents({}))
      setStoredServices(await new ServiceRepository(store).getServices())
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

  const pendingEit = useRef(new Map<number, Map<number, Event>>())
  const flushTimers = useRef(new Map<number, number>())
  const mountedRef = useRef(true)

  const flushService = useCallback(
    async (serviceId: number) => {
      const timer = flushTimers.current.get(serviceId)
      if (timer !== undefined) {
        window.clearTimeout(timer)
        flushTimers.current.delete(serviceId)
      }
      const buffered = pendingEit.current.get(serviceId)
      if (!buffered || buffered.size === 0) return
      pendingEit.current.delete(serviceId)
      const events = [...buffered.values()]
      try {
        const store = await openAppKeyValueStore()
        await new EventRepository(store).replaceEventsForServices(events)
      } catch {
        // storage unavailable
      }
      if (mountedRef.current) await reload()
    },
    [reload],
  )

  const scheduleFlush = useCallback(
    (serviceId: number) => {
      const existing = flushTimers.current.get(serviceId)
      if (existing !== undefined) window.clearTimeout(existing)
      const timer = window.setTimeout(() => {
        flushTimers.current.delete(serviceId)
        void flushService(serviceId)
      }, EIT_SETTLE_MS)
      flushTimers.current.set(serviceId, timer)
    },
    [flushService],
  )

  useEffect(() => {
    mountedRef.current = true
    const timers = flushTimers.current
    return () => {
      mountedRef.current = false
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  useEffect(() => {
    if (!eit || eit.events.length === 0) return
    const receivedAt = new Date()
    for (const raw of eit.events) {
      const event = { ...raw, updatedAt: receivedAt }
      const buffered = pendingEit.current.get(event.serviceId) ?? new Map<number, Event>()
      buffered.set(event.eventId, event)
      pendingEit.current.set(event.serviceId, buffered)
    }
    for (const serviceId of new Set(eit.events.map((event) => event.serviceId)))
      scheduleFlush(serviceId)
  }, [eit, scheduleFlush])

  useEffect(() => {
    if (liveChannel === null || liveServices.length === 0) return
    const services = liveServices.map((service) => ({ ...service, physicalChannel: liveChannel }))
    void (async () => {
      try {
        const store = await openAppKeyValueStore()
        await new ServiceRepository(store).upsertServices(services)
        setStoredServices((prev) => mergeServices(prev, services))
      } catch {
        // storage unavailable
      }
    })()
  }, [liveChannel, liveServices])

  const serviceNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const service of liveServices) map.set(service.serviceId, service.name)
    for (const services of scanServices.values()) {
      for (const service of services)
        if (!map.has(service.serviceId)) map.set(service.serviceId, service.name)
    }
    for (const service of storedServices) {
      if (!map.has(service.serviceId)) map.set(service.serviceId, service.name)
    }
    return map
  }, [liveServices, scanServices, storedServices])

  const serviceIdsByChannel = useMemo(
    () =>
      groupServiceIdsByChannel({
        channels,
        scanServices,
        storedServices,
        liveChannel,
        liveServices,
      }),
    [channels, scanServices, storedServices, liveChannel, liveServices],
  )

  const allEvents = storedEvents

  const guide = useMemo(
    () => buildChannelGuide(channels, allEvents, serviceNames, serviceIdsByChannel, { hours, now }),
    [channels, allEvents, serviceNames, serviceIdsByChannel, hours, now],
  )

  const selectChannel = useCallback((entry: ChannelGuideEntry) => {
    void receiverController.tunePhysicalChannel(entry.physicalChannel)
  }, [])

  return { guide, loading, selectChannel }
}
