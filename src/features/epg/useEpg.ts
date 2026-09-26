import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { receiverController } from '../../app/receiverController'
import { loadStoredScanResults, openAppKeyValueStore } from '../../app/scanController'
import { store as appStore, useStore } from '../../app/store'
import type { ConfiguredChannel, EitSection, Event, Service } from '../../models'
import { EventRepository, pruneExpiredEvents, ServiceRepository } from '../../storage'

/** Keep ended programs around briefly so the guide can show the recent past. */
export const EPG_RETENTION_MS = 3 * 60 * 60 * 1000

/**
 * EIT arrives as many small sections per service. Wait until a service stops
 * reporting before replacing its cache wholesale, so programs from other tables
 * are never dropped in between.
 */
export const EIT_SETTLE_MS = 3000

/**
 * Upper bound on the settle window. Present/following EIT repeats continuously,
 * so the settle timer keeps resetting and a tuned service would otherwise never
 * reach storage. The cap guarantees a flush while the service stays on air.
 */
export const EIT_MAX_SETTLE_MS = 5000

/** Coalesce storage reloads when several services settle at the same time. */
const RELOAD_COALESCE_MS = 200

export interface ChannelGuideEntry {
  physicalChannel: number
  serviceId: number | null
  serviceName: string
  logo?: string
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
  /** Derive the time range from the fetched events instead of a fixed window. */
  auto?: boolean
  now?: Date
  /** Simple station logo per service, keyed by service ID. */
  serviceLogos?: ReadonlyMap<number, string>
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

/** Merge live EIT into the accumulated set so the guide updates before persistence. */
export function accumulateLiveEvents(current: Event[], incoming: Event[]): Event[] {
  if (incoming.length === 0) return current
  return [...mergeEvents([...current, ...incoming]).values()]
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
  const auto = options.auto ?? false
  const hours = options.hours ?? 6
  const pastHours = options.pastHours ?? 1
  const rangeStart = new Date(now.getTime() - pastHours * 3_600_000)
  const rangeEnd = new Date(now.getTime() + hours * 3_600_000)
  const merged = mergeEvents(events)

  const entries: ChannelGuideEntry[] = []
  let total = 0
  let earliestStart = Number.POSITIVE_INFINITY
  let latestEnd = Number.NEGATIVE_INFINITY
  for (const channel of channels) {
    const ids = new Set<number>()
    if (channel.serviceId !== undefined) ids.add(channel.serviceId)
    for (const id of serviceIdsByChannel.get(channel.physicalChannel) ?? []) ids.add(id)

    const channelEvents: Event[] = []
    for (const event of merged.values()) {
      if (!ids.has(event.serviceId)) continue
      const start = event.startTime.getTime()
      const end = start + event.duration * 1000
      if (!auto && (end < rangeStart.getTime() || start > rangeEnd.getTime())) continue
      channelEvents.push(event)
      if (start < earliestStart) earliestStart = start
      if (end > latestEnd) latestEnd = end
    }
    channelEvents.sort((a, b) => a.startTime.getTime() - b.startTime.getTime())

    const primaryId = channel.serviceId ?? [...ids][0] ?? null
    const serviceName =
      channel.name ??
      (primaryId !== null ? serviceNames.get(primaryId) : undefined) ??
      `ch ${channel.physicalChannel}`

    let logo = primaryId !== null ? options.serviceLogos?.get(primaryId) : undefined
    if (!logo) {
      for (const id of ids) {
        const candidate = options.serviceLogos?.get(id)
        if (candidate) {
          logo = candidate
          break
        }
      }
    }

    entries.push({
      physicalChannel: channel.physicalChannel,
      serviceId: primaryId,
      serviceName,
      ...(logo ? { logo } : {}),
      events: channelEvents,
    })
    total += channelEvents.length
  }

  if (auto && Number.isFinite(earliestStart) && Number.isFinite(latestEnd)) {
    return {
      generatedAt: now,
      rangeStart: new Date(Math.min(earliestStart, now.getTime())),
      rangeEnd: new Date(Math.max(latestEnd, now.getTime())),
      entries,
      total,
    }
  }

  return { generatedAt: now, rangeStart, rangeEnd, entries, total }
}

export interface EpgState {
  guide: ChannelGuide
  loading: boolean
  selectChannel(entry: ChannelGuideEntry): void
}

export interface UseEpgOptions {
  hours?: number
  pastHours?: number
  /** Show every fetched event and size the range to it instead of a fixed window. */
  auto?: boolean
}

export function useEpg(options: UseEpgOptions = {}): EpgState {
  const { hours, pastHours, auto } = options
  const channels = useStore((state) => state.configuredChannels)
  const liveServices = useStore((state) => state.diagnostics.services)
  const liveChannel = useStore((state) => state.receiver.channel)
  const [storedEvents, setStoredEvents] = useState<Event[]>([])
  const [liveEvents, setLiveEvents] = useState<Event[]>([])
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
    const timer = window.setInterval(() => {
      const current = new Date()
      setNow(current)
      const cutoff = current.getTime() - EPG_RETENTION_MS
      setLiveEvents((prev) => {
        const kept = prev.filter(
          (event) => event.startTime.getTime() + event.duration * 1000 >= cutoff,
        )
        return kept.length === prev.length ? prev : kept
      })
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const reloadTimer = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const pendingEit = useRef(new Map<number, Map<number, Event>>())
  const flushTimers = useRef(new Map<number, number>())
  const maxFlushTimers = useRef(new Map<number, number>())

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current !== null) return
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null
      if (mountedRef.current) void reload()
    }, RELOAD_COALESCE_MS)
  }, [reload])

  const flushService = useCallback(
    async (serviceId: number) => {
      const timer = flushTimers.current.get(serviceId)
      if (timer !== undefined) {
        window.clearTimeout(timer)
        flushTimers.current.delete(serviceId)
      }
      const maxTimer = maxFlushTimers.current.get(serviceId)
      if (maxTimer !== undefined) {
        window.clearTimeout(maxTimer)
        maxFlushTimers.current.delete(serviceId)
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
      if (mountedRef.current) scheduleReload()
    },
    [scheduleReload],
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
      if (!maxFlushTimers.current.has(serviceId)) {
        const maxTimer = window.setTimeout(() => {
          maxFlushTimers.current.delete(serviceId)
          void flushService(serviceId)
        }, EIT_MAX_SETTLE_MS)
        maxFlushTimers.current.set(serviceId, maxTimer)
      }
    },
    [flushService],
  )

  useEffect(() => {
    mountedRef.current = true
    const timers = flushTimers.current
    const maxTimers = maxFlushTimers.current
    return () => {
      mountedRef.current = false
      for (const timer of timers.values()) window.clearTimeout(timer)
      timers.clear()
      for (const timer of maxTimers.values()) window.clearTimeout(timer)
      maxTimers.clear()
      if (reloadTimer.current !== null) {
        window.clearTimeout(reloadTimer.current)
        reloadTimer.current = null
      }
    }
  }, [])

  useEffect(() => {
    let latest: EitSection | null = null
    const handleSection = (section: EitSection): void => {
      if (section.events.length === 0) return
      const receivedAt = new Date()
      const incoming = section.events.map((raw) => ({ ...raw, updatedAt: receivedAt }))
      setLiveEvents((prev) => accumulateLiveEvents(prev, incoming))
      for (const event of incoming) {
        const buffered = pendingEit.current.get(event.serviceId) ?? new Map<number, Event>()
        buffered.set(event.eventId, event)
        pendingEit.current.set(event.serviceId, buffered)
      }
      for (const serviceId of new Set(incoming.map((event) => event.serviceId)))
        scheduleFlush(serviceId)
    }
    return appStore.subscribe(() => {
      const section = appStore.getState().diagnostics.eit
      if (!section || section === latest) return
      latest = section
      handleSection(section)
    })
  }, [scheduleFlush])

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

  const serviceLogos = useMemo(() => {
    const map = new Map<number, string>()
    for (const service of liveServices) {
      if (service.logo) map.set(service.serviceId, service.logo)
    }
    for (const services of scanServices.values()) {
      for (const service of services) {
        if (service.logo && !map.has(service.serviceId)) map.set(service.serviceId, service.logo)
      }
    }
    for (const service of storedServices) {
      if (service.logo && !map.has(service.serviceId)) map.set(service.serviceId, service.logo)
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

  const allEvents = useMemo(
    () => accumulateLiveEvents(storedEvents, liveEvents),
    [storedEvents, liveEvents],
  )

  const guide = useMemo(
    () =>
      buildChannelGuide(channels, allEvents, serviceNames, serviceIdsByChannel, {
        hours,
        pastHours,
        auto,
        now,
        serviceLogos,
      }),
    [
      channels,
      allEvents,
      serviceNames,
      serviceIdsByChannel,
      hours,
      pastHours,
      auto,
      now,
      serviceLogos,
    ],
  )

  const selectChannel = useCallback((entry: ChannelGuideEntry) => {
    void receiverController.tunePhysicalChannel(entry.physicalChannel)
  }, [])

  return { guide, loading, selectChannel }
}
