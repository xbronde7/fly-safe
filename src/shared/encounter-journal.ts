export const ENCOUNTER_JOURNAL_LIMITS = {
  localPilotsPerSnapshot: 2_000,
  dscanHullsPerSnapshot: 2_000,
  hullCount: 100_000,
  queryResults: 200
} as const

export interface EncounterSystemInput {
  solarSystemId: number
  name?: string | null
}

export interface EncounterOwnShipInput {
  typeId: number
  typeName?: string | null
  customName?: string | null
}

export interface EncounterLocalPilotInput {
  characterId?: number | null
  name: string
  corporationName?: string | null
}

export interface EncounterDscanHullInput {
  typeId?: number | null
  typeName?: string | null
  count?: number
}

/** Fixed, token-free IPC payload accepted by EncounterJournalStore.record(). */
export interface EncounterSnapshotInput {
  capturedAt?: string
  currentSystem: EncounterSystemInput
  ownShip?: EncounterOwnShipInput | null
  localPilots?: EncounterLocalPilotInput[]
  dscanHulls?: EncounterDscanHullInput[]
}

export interface NormalizedEncounterSnapshotInput {
  capturedAt: string
  currentSystem: {
    solarSystemId: number
    name: string | null
  }
  ownShip: {
    typeId: number
    typeName: string | null
    customName: string | null
  } | null
  localPilots: EncounterLocalPilot[]
  dscanHulls: EncounterDscanHull[]
}

export interface EncounterLocalPilot {
  characterId: number | null
  name: string
  corporationName: string | null
}

export interface EncounterDscanHull {
  typeId: number | null
  typeName: string | null
  count: number
}

export interface EncounterSnapshot extends NormalizedEncounterSnapshotInput {
  id: number
  recordedAt: string
}

export interface EncounterRecentQuery {
  limit?: number
  before?: string
  solarSystemId?: number
}

export interface NormalizedEncounterRecentQuery {
  limit: number
  before: string | null
  solarSystemId: number | null
}

export interface EncounterJournalPage {
  snapshots: EncounterSnapshot[]
  hasMore: boolean
}

export interface EncounterPilotSearchQuery {
  characterId?: number
  name?: string
  limit?: number
  since?: string
  before?: string
}

export interface NormalizedEncounterPilotSearchQuery {
  characterId: number | null
  name: string | null
  normalizedName: string | null
  limit: number
  since: string | null
  before: string | null
}

export interface EncounterPilotSearchMatch {
  snapshot: EncounterSnapshot
  matchedPilot: EncounterLocalPilot
}

export interface EncounterPilotSearchPage {
  matches: EncounterPilotSearchMatch[]
  hasMore: boolean
}

type UnknownRecord = Record<string, unknown>

export function validateEncounterSnapshotInput(
  value: unknown,
  now: () => number = Date.now
): NormalizedEncounterSnapshotInput {
  const input = strictRecord(
    value,
    ['capturedAt', 'currentSystem', 'ownShip', 'localPilots', 'dscanHulls'],
    'encounter snapshot'
  )
  const capturedAt = input.capturedAt === undefined
    ? new Date(validNow(now)).toISOString()
    : isoTimestamp(input.capturedAt, 'snapshot time')
  const system = strictRecord(input.currentSystem, ['solarSystemId', 'name'], 'current system')
  const currentSystem = {
    solarSystemId: positiveInteger(system.solarSystemId, 'System ID'),
    name: optionalText(system.name, 128, 'system name')
  }

  let ownShip: NormalizedEncounterSnapshotInput['ownShip'] = null
  if (input.ownShip !== undefined && input.ownShip !== null) {
    const ship = strictRecord(input.ownShip, ['typeId', 'typeName', 'customName'], 'own ship')
    ownShip = {
      typeId: positiveInteger(ship.typeId, 'Own ship ID'),
      typeName: optionalText(ship.typeName, 256, 'own ship type'),
      customName: optionalText(ship.customName, 256, 'own ship name')
    }
  }

  const rawLocalPilots = optionalArray(
    input.localPilots,
    ENCOUNTER_JOURNAL_LIMITS.localPilotsPerSnapshot,
    'Local pilots'
  )
  const localPilots: EncounterLocalPilot[] = []
  const localKeys = new Set<string>()
  for (const [index, rawPilot] of rawLocalPilots.entries()) {
    const pilot = strictRecord(
      rawPilot,
      ['characterId', 'name', 'corporationName'],
      `Local pilot #${index + 1}`
    )
    const characterId = pilot.characterId === undefined || pilot.characterId === null
      ? null
      : positiveInteger(pilot.characterId, `Local pilot ID #${index + 1}`)
    const name = requiredText(pilot.name, 128, `Local pilot name #${index + 1}`)
    const key = characterId === null ? `name:${normalizeEncounterPilotName(name)}` : `id:${characterId}`
    if (localKeys.has(key)) throw new TypeError(`Duplicate Local pilot: ${name}`)
    localKeys.add(key)
    localPilots.push({
      characterId,
      name,
      corporationName: optionalText(
        pilot.corporationName,
        256,
        `Local pilot corporation #${index + 1}`
      )
    })
  }

  const rawDscanHulls = optionalArray(
    input.dscanHulls,
    ENCOUNTER_JOURNAL_LIMITS.dscanHullsPerSnapshot,
    'D-scan hulls'
  )
  const hulls = new Map<string, EncounterDscanHull>()
  for (const [index, rawHull] of rawDscanHulls.entries()) {
    const hull = strictRecord(
      rawHull,
      ['typeId', 'typeName', 'count'],
      `D-scan hull #${index + 1}`
    )
    const typeId = hull.typeId === undefined || hull.typeId === null
      ? null
      : positiveInteger(hull.typeId, `D-scan hull ID #${index + 1}`)
    const typeName = optionalText(hull.typeName, 256, `D-scan hull type #${index + 1}`)
    if (typeId === null && typeName === null) {
      throw new TypeError(`D-scan hull #${index + 1} needs an ID or type`)
    }
    const count = hull.count === undefined
      ? 1
      : boundedInteger(
          hull.count,
          1,
          ENCOUNTER_JOURNAL_LIMITS.hullCount,
          `D-scan hull count #${index + 1}`
        )
    const key = typeId === null
      ? `name:${normalizeTypeName(typeName!)}`
      : `id:${typeId}`
    const existing = hulls.get(key)
    if (existing) {
      const nextCount = existing.count + count
      if (nextCount > ENCOUNTER_JOURNAL_LIMITS.hullCount) {
        throw new TypeError(`Too many D-scan hulls of type ${typeName ?? typeId}`)
      }
      existing.count = nextCount
      existing.typeName ??= typeName
    } else {
      hulls.set(key, { typeId, typeName, count })
    }
  }

  return {
    capturedAt,
    currentSystem,
    ownShip,
    localPilots,
    dscanHulls: [...hulls.values()]
  }
}

export function validateEncounterRecentQuery(value: unknown = {}): NormalizedEncounterRecentQuery {
  const query = strictRecord(value, ['limit', 'before', 'solarSystemId'], 'journal request')
  return {
    limit: queryLimit(query.limit),
    before: query.before === undefined ? null : isoTimestamp(query.before, 'upper time bound'),
    solarSystemId: query.solarSystemId === undefined
      ? null
      : positiveInteger(query.solarSystemId, 'System ID')
  }
}

export function validateEncounterPilotSearchQuery(
  value: unknown
): NormalizedEncounterPilotSearchQuery {
  const query = strictRecord(
    value,
    ['characterId', 'name', 'limit', 'since', 'before'],
    'pilot search'
  )
  const characterId = query.characterId === undefined
    ? null
    : positiveInteger(query.characterId, 'Pilot ID')
  const name = query.name === undefined ? null : requiredText(query.name, 128, 'pilot name')
  if (characterId === null && name === null) {
    throw new TypeError('Search needs a pilot ID or name')
  }
  const since = query.since === undefined ? null : isoTimestamp(query.since, 'search start')
  const before = query.before === undefined ? null : isoTimestamp(query.before, 'search end')
  if (since !== null && before !== null && Date.parse(since) >= Date.parse(before)) {
    throw new TypeError('Search start must precede search end')
  }
  return {
    characterId,
    name,
    normalizedName: name === null ? null : normalizeEncounterPilotName(name),
    limit: queryLimit(query.limit),
    since,
    before
  }
}

export function normalizeEncounterPilotName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US')
}

function strictRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  const record = value as UnknownRecord
  const allowed = new Set(keys)
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown ${label} field: ${key}`)
  }
  return record
}

function optionalArray(value: unknown, maximum: number, label: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`Invalid field: ${label}`)
  }
  return value
}

function requiredText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`Invalid field: ${label}`)
  const result = cleanText(value)
  if (!result || result.length > maximum) throw new TypeError(`Invalid field: ${label}`)
  return result
}

function optionalText(value: unknown, maximum: number, label: string): string | null {
  if (value === undefined || value === null) return null
  return requiredText(value, maximum, label)
}

function cleanText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\u2060\ufeff]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ')
}

function normalizeTypeName(value: string): string {
  return cleanText(value).toLocaleLowerCase('en-US')
}

function positiveInteger(value: unknown, label: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, label)
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

function queryLimit(value: unknown): number {
  return value === undefined
    ? 50
    : boundedInteger(value, 1, ENCOUNTER_JOURNAL_LIMITS.queryResults, 'result limit')
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Invalid field: ${label}`)
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new TypeError(`Invalid field: ${label}`)
  return new Date(parsed).toISOString()
}

function validNow(now: () => number): number {
  const value = now()
  if (!Number.isFinite(value)) throw new TypeError('Invalid system clock')
  return value
}
