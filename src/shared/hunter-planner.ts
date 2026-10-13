import { normalizeEncounterPilotName, type EncounterSnapshot } from './encounter-journal'

export interface HunterPlannerOptions {
  /** Fixed display offset. Example: UTC+5 = 300. */
  timezoneOffsetMinutes?: number
  /** Repeated snapshots in the same system and bucket count once. Default: 60. */
  activityBucketMinutes?: number
}

export interface HunterPlanRequest extends HunterPlannerOptions {
  /** Optional ISO lower bound. The local store still enforces its retention window. */
  since?: string
}

export interface HunterHeatmapCell {
  /** JavaScript convention: 0 = Sunday, 6 = Saturday. */
  weekday: number
  hour: number
  encounters: number
  uniqueTargets: number
  uniqueSystems: number
}

export interface HunterActiveHour {
  hour: number
  encounters: number
  share: number
}

export interface HunterWeekdayHour {
  weekday: number
  hour: number
  encounters: number
}

export interface HunterTargetSystemPattern {
  solarSystemId: number
  name: string | null
  encounters: number
  share: number
  lastSeenAt: string
}

export interface HunterTargetPattern {
  key: string
  characterId: number | null
  name: string
  aliases: string[]
  encounters: number
  distinctDays: number
  firstSeenAt: string
  lastSeenAt: string
  confidence: 'low' | 'medium' | 'high'
  activeHours: HunterActiveHour[]
  strongestWindows: HunterWeekdayHour[]
  systems: HunterTargetSystemPattern[]
}

export interface HunterSystemPattern {
  solarSystemId: number
  name: string | null
  encounters: number
  uniqueTargets: number
  firstSeenAt: string
  lastSeenAt: string
  activeHours: HunterActiveHour[]
}

export interface HunterPlan {
  timezoneOffsetMinutes: number
  activityBucketMinutes: number
  sourceSnapshotCount: number
  encounters: number
  heatmap: HunterHeatmapCell[]
  targets: HunterTargetPattern[]
  systems: HunterSystemPattern[]
}

interface ValidSnapshot {
  snapshot: EncounterSnapshot
  timestamp: number
}

interface TargetEvent {
  key: string
  characterId: number | null
  name: string
  aliases: Set<string>
  solarSystemId: number
  systemName: string | null
  timestamp: number
  capturedAt: string
  localDay: string
  weekday: number
  hour: number
}

interface SystemEvent {
  solarSystemId: number
  systemName: string | null
  timestamp: number
  capturedAt: string
  localDay: string
  weekday: number
  hour: number
  targetKeys: Set<string>
}

/** Build stable activity patterns from the existing local encounter journal. */
export function buildHunterPlan(
  snapshots: readonly EncounterSnapshot[],
  options: HunterPlannerOptions = {}
): HunterPlan {
  const timezoneOffsetMinutes = boundedInteger(
    options.timezoneOffsetMinutes ?? 0,
    -14 * 60,
    14 * 60,
    'timezone offset'
  )
  const activityBucketMinutes = boundedInteger(
    options.activityBucketMinutes ?? 60,
    5,
    24 * 60,
    'time-window size'
  )
  const validSnapshots = snapshots
    .map((snapshot) => ({ snapshot, timestamp: Date.parse(snapshot.capturedAt) }))
    .filter((entry): entry is ValidSnapshot => (
      Number.isFinite(entry.timestamp) &&
      Number.isSafeInteger(entry.snapshot.currentSystem.solarSystemId) &&
      entry.snapshot.currentSystem.solarSystemId > 0
    ))
    .sort((left, right) => left.timestamp - right.timestamp || left.snapshot.id - right.snapshot.id)

  const uniqueCharacterIdsByName = collectResolvedNames(validSnapshots)
  const bucketMs = activityBucketMinutes * 60_000
  const targetEvents = new Map<string, TargetEvent>()
  const systemEvents = new Map<string, SystemEvent>()

  for (const { snapshot, timestamp } of validSnapshots) {
    const local = localParts(timestamp, timezoneOffsetMinutes)
    const bucket = Math.floor((timestamp + timezoneOffsetMinutes * 60_000) / bucketMs)
    const systemId = snapshot.currentSystem.solarSystemId
    const systemEventKey = `${systemId}|${bucket}`
    let systemEvent = systemEvents.get(systemEventKey)
    if (!systemEvent) {
      systemEvent = {
        solarSystemId: systemId,
        systemName: snapshot.currentSystem.name,
        timestamp,
        capturedAt: new Date(timestamp).toISOString(),
        localDay: local.day,
        weekday: local.weekday,
        hour: local.hour,
        targetKeys: new Set()
      }
      systemEvents.set(systemEventKey, systemEvent)
    } else if (timestamp > systemEvent.timestamp) {
      systemEvent.timestamp = timestamp
      systemEvent.capturedAt = new Date(timestamp).toISOString()
      systemEvent.systemName = snapshot.currentSystem.name ?? systemEvent.systemName
    }

    for (const pilot of snapshot.localPilots) {
      const normalizedName = normalizeEncounterPilotName(pilot.name)
      if (!normalizedName) continue
      const resolvedIds = uniqueCharacterIdsByName.get(normalizedName)
      const characterId = validCharacterId(pilot.characterId) ?? (
        resolvedIds?.size === 1 ? [...resolvedIds][0] : null
      )
      const targetKey = characterId === null ? `name:${normalizedName}` : `id:${characterId}`
      const eventKey = `${targetKey}|${systemId}|${bucket}`
      systemEvent.targetKeys.add(targetKey)
      const existing = targetEvents.get(eventKey)
      if (existing) {
        existing.aliases.add(cleanName(pilot.name))
        if (timestamp > existing.timestamp) {
          existing.timestamp = timestamp
          existing.capturedAt = new Date(timestamp).toISOString()
          existing.name = cleanName(pilot.name)
          existing.systemName = snapshot.currentSystem.name ?? existing.systemName
        }
      } else {
        targetEvents.set(eventKey, {
          key: targetKey,
          characterId,
          name: cleanName(pilot.name),
          aliases: new Set([cleanName(pilot.name)]),
          solarSystemId: systemId,
          systemName: snapshot.currentSystem.name,
          timestamp,
          capturedAt: new Date(timestamp).toISOString(),
          localDay: local.day,
          weekday: local.weekday,
          hour: local.hour
        })
      }
    }
  }

  const targetEventList = [...targetEvents.values()]
  const systemEventList = [...systemEvents.values()]
  return {
    timezoneOffsetMinutes,
    activityBucketMinutes,
    sourceSnapshotCount: validSnapshots.length,
    encounters: systemEventList.length,
    heatmap: buildHeatmap(systemEventList, targetEventList),
    targets: buildTargetPatterns(targetEventList),
    systems: buildSystemPatterns(systemEventList, targetEventList)
  }
}

function collectResolvedNames(snapshots: readonly ValidSnapshot[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>()
  for (const { snapshot } of snapshots) {
    for (const pilot of snapshot.localPilots) {
      const characterId = validCharacterId(pilot.characterId)
      if (characterId === null) continue
      const name = normalizeEncounterPilotName(pilot.name)
      if (!name) continue
      const ids = result.get(name) ?? new Set<number>()
      ids.add(characterId)
      result.set(name, ids)
    }
  }
  return result
}

function buildHeatmap(
  systemEvents: readonly SystemEvent[],
  targetEvents: readonly TargetEvent[]
): HunterHeatmapCell[] {
  const targetKeys = new Map<string, Set<string>>()
  const systemIds = new Map<string, Set<number>>()
  for (const event of targetEvents) {
    const key = `${event.weekday}|${event.hour}`
    const targets = targetKeys.get(key) ?? new Set<string>()
    targets.add(event.key)
    targetKeys.set(key, targets)
  }
  for (const event of systemEvents) {
    const key = `${event.weekday}|${event.hour}`
    const systems = systemIds.get(key) ?? new Set<number>()
    systems.add(event.solarSystemId)
    systemIds.set(key, systems)
  }
  const encounterCounts = countBy(systemEvents, (event) => `${event.weekday}|${event.hour}`)
  const cells: HunterHeatmapCell[] = []
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      const key = `${weekday}|${hour}`
      cells.push({
        weekday,
        hour,
        encounters: encounterCounts.get(key) ?? 0,
        uniqueTargets: targetKeys.get(key)?.size ?? 0,
        uniqueSystems: systemIds.get(key)?.size ?? 0
      })
    }
  }
  return cells
}

function buildTargetPatterns(events: readonly TargetEvent[]): HunterTargetPattern[] {
  const groups = groupBy(events, (event) => event.key)
  return [...groups.entries()].map(([key, entries]) => {
    const sorted = [...entries].sort((left, right) => left.timestamp - right.timestamp)
    const latest = sorted.at(-1)!
    const systemGroups = groupBy(entries, (entry) => String(entry.solarSystemId))
    const aliases = new Set<string>()
    for (const entry of entries) for (const alias of entry.aliases) aliases.add(alias)
    return {
      key,
      characterId: latest.characterId,
      name: latest.name,
      aliases: [...aliases].sort((left, right) => left.localeCompare(right, 'en-US')),
      encounters: entries.length,
      distinctDays: new Set(entries.map((entry) => entry.localDay)).size,
      firstSeenAt: sorted[0].capturedAt,
      lastSeenAt: latest.capturedAt,
      confidence: patternConfidence(entries.length, new Set(entries.map((entry) => entry.localDay)).size),
      activeHours: activeHours(entries),
      strongestWindows: strongestWindows(entries),
      systems: [...systemGroups.values()].map((systemEntries) => {
        const last = [...systemEntries].sort((left, right) => right.timestamp - left.timestamp)[0]
        return {
          solarSystemId: last.solarSystemId,
          name: last.systemName,
          encounters: systemEntries.length,
          share: ratio(systemEntries.length, entries.length),
          lastSeenAt: last.capturedAt
        }
      }).sort((left, right) => (
        right.encounters - left.encounters || right.lastSeenAt.localeCompare(left.lastSeenAt)
      ))
    }
  }).sort((left, right) => (
    right.encounters - left.encounters || right.lastSeenAt.localeCompare(left.lastSeenAt)
  ))
}

function buildSystemPatterns(
  systemEvents: readonly SystemEvent[],
  targetEvents: readonly TargetEvent[]
): HunterSystemPattern[] {
  const eventsBySystem = groupBy(systemEvents, (event) => String(event.solarSystemId))
  const targetsBySystem = groupBy(targetEvents, (event) => String(event.solarSystemId))
  return [...eventsBySystem.values()].map((entries) => {
    const sorted = [...entries].sort((left, right) => left.timestamp - right.timestamp)
    const latest = sorted.at(-1)!
    const targetEntries = targetsBySystem.get(String(latest.solarSystemId)) ?? []
    return {
      solarSystemId: latest.solarSystemId,
      name: latest.systemName,
      encounters: entries.length,
      uniqueTargets: new Set(targetEntries.map((entry) => entry.key)).size,
      firstSeenAt: sorted[0].capturedAt,
      lastSeenAt: latest.capturedAt,
      activeHours: activeHours(entries)
    }
  }).sort((left, right) => (
    right.encounters - left.encounters || right.lastSeenAt.localeCompare(left.lastSeenAt)
  ))
}

function activeHours(events: ReadonlyArray<{ hour: number }>): HunterActiveHour[] {
  const counts = countBy(events, (event) => String(event.hour))
  return [...counts.entries()].map(([hour, encounters]) => ({
    hour: Number(hour),
    encounters,
    share: ratio(encounters, events.length)
  })).sort((left, right) => right.encounters - left.encounters || left.hour - right.hour)
}

function strongestWindows(events: readonly TargetEvent[]): HunterWeekdayHour[] {
  const counts = countBy(events, (event) => `${event.weekday}|${event.hour}`)
  return [...counts.entries()].map(([key, encounters]) => {
    const [weekday, hour] = key.split('|').map(Number)
    return { weekday, hour, encounters }
  }).sort((left, right) => (
    right.encounters - left.encounters || left.weekday - right.weekday || left.hour - right.hour
  )).slice(0, 5)
}

function patternConfidence(encounters: number, distinctDays: number): HunterTargetPattern['confidence'] {
  if (encounters >= 6 && distinctDays >= 3) return 'high'
  if (encounters >= 3 && distinctDays >= 2) return 'medium'
  return 'low'
}

function localParts(
  timestamp: number,
  timezoneOffsetMinutes: number
): { day: string; weekday: number; hour: number } {
  const local = new Date(timestamp + timezoneOffsetMinutes * 60_000)
  return {
    day: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay(),
    hour: local.getUTCHours()
  }
}

function validCharacterId(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function cleanName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
}

function ratio(value: number, total: number): number {
  return total === 0 ? 0 : Math.round((value / total) * 10_000) / 10_000
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) {
    const itemKey = key(value)
    counts.set(itemKey, (counts.get(itemKey) ?? 0) + 1)
  }
  return counts
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const itemKey = key(value)
    const group = groups.get(itemKey) ?? []
    group.push(value)
    groups.set(itemKey, group)
  }
  return groups
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return value
}
