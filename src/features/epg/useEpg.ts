import { useCallback, useEffect, useMemo, useState } from 'react'
import { receiverController } from '../../app/receiverController'
import { openAppKeyValueStore } from '../../app/scanController'
import { useStore } from '../../app/store'
import { getChannel, loadStations } from '../../data/japan/loader'
import type { Event, Service } from '../../models'
import { EventRepository, pruneExpiredEvents } from '../../storage'

/** Keep ended programs around briefly so the guide can show the recent past. */
export const EPG_RETENTION_MS = 3 * 60 * 60 * 1000

export interface ProgramGuideGroup {
  serviceId: number
  serviceName: string
  events: Event[]
}

export interface ProgramGuide {
  generatedAt: Date
  rangeStart: Date
  rangeEnd: Date
  groups: ProgramGuideGroup[]
  total: number
}

export interface ProgramGuideOptions {
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

/** Merge live and stored events into a per-service guide for the given window. */
export function buildProgramGuide(
  events: Event[],
  services: Service[],
  options: ProgramGuideOptions = {},
): ProgramGuide {
  const now = options.now ?? new Date()
  const hours = options.hours ?? 6
  const pastHours = options.pastHours ?? 1
  const rangeStart = new Date(now.getTime() - pastHours * 3_600_000)
  const rangeEnd = new Date(now.getTime() + hours * 3_600_000)

  const merged = new Map<string, Event>()
  for (const event of events) {
    const key = `${event.serviceId}:${event.eventId}`
    const existing = merged.get(key)
    if (!existing || preferEvent(event, existing)) merged.set(key, event)
  }

  const names = new Map<number, string>()
  for (const service of services) names.set(service.serviceId, service.name)

  const groups = new Map<number, ProgramGuideGroup>()
  let total = 0
  for (const event of merged.values()) {
    const start = event.startTime.getTime()
    const end = start + event.duration * 1000
    if (end < rangeStart.getTime() || start > rangeEnd.getTime()) continue
    let group = groups.get(event.serviceId)
    if (!group) {
      group = {
        serviceId: event.serviceId,
        serviceName: names.get(event.serviceId) ?? `サービス ${event.serviceId}`,
        events: [],
      }
      groups.set(event.serviceId, group)
    }
    group.events.push(event)
    total++
  }

  const sortedGroups = [...groups.values()].toSorted((a, b) => a.serviceId - b.serviceId)
  for (const group of sortedGroups) {
    group.events = group.events.toSorted((a, b) => a.startTime.getTime() - b.startTime.getTime())
  }

  return { generatedAt: now, rangeStart, rangeEnd, groups: sortedGroups, total }
}

export interface EpgState {
  guide: ProgramGuide
  services: Service[]
  loading: boolean
  resolveChannel(serviceId: number): number | null
  selectProgram(event: Event): void
  refresh(): void
}

export function useEpg(hours = 6): EpgState {
  const eit = useStore((state) => state.diagnostics.eit)
  const services = useStore((state) => state.diagnostics.services)
  const [storedEvents, setStoredEvents] = useState<Event[]>([])
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

  const channelByServiceId = useMemo(() => {
    const map = new Map<number, number>()
    for (const station of loadStations()) {
      if (station.serviceId === undefined) continue
      const channel = getChannel(station.channelId)
      if (channel) map.set(station.serviceId, channel.physicalChannel)
    }
    return map
  }, [])

  const channelByName = useMemo(() => {
    const map = new Map<string, number>()
    for (const station of loadStations()) {
      const channel = getChannel(station.channelId)
      if (channel) map.set(station.name, channel.physicalChannel)
    }
    return map
  }, [])

  const resolveChannel = useCallback(
    (serviceId: number): number | null => {
      const direct = channelByServiceId.get(serviceId)
      if (direct !== undefined) return direct
      const service = services.find((candidate) => candidate.serviceId === serviceId)
      if (!service) return null
      return channelByName.get(service.name) ?? null
    },
    [channelByServiceId, channelByName, services],
  )

  const selectProgram = useCallback(
    (event: Event) => {
      const channel = resolveChannel(event.serviceId)
      if (channel !== null) void receiverController.tunePhysicalChannel(channel)
      receiverController.selectService(event.serviceId)
    },
    [resolveChannel],
  )

  const allEvents = useMemo(() => [...storedEvents, ...(eit?.events ?? [])], [storedEvents, eit])

  const guide = useMemo(
    () => buildProgramGuide(allEvents, services, { hours, now }),
    [allEvents, services, hours, now],
  )

  const refresh = useCallback(() => {
    setNow(new Date())
    void reload()
  }, [reload])

  return { guide, services, loading, resolveChannel, selectProgram, refresh }
}
