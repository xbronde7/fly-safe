import { parseLocalRoster } from './local-parser'

export type EveClipboardKind = 'local' | 'dscan' | 'probe' | 'unknown'
export type EveDistanceUnit = 'm' | 'km' | 'au'
export type ProbeResultKind = 'signature' | 'anomaly' | 'unknown'

export interface EveDistance {
  /** Exact, trimmed value copied from EVE. Useful when locale precision matters. */
  text: string
  value: number
  unit: EveDistanceUnit
  meters: number
}

export interface DscanRow {
  /** EVE inventory type ID when the native three-column clipboard format provides it. */
  typeId: number | null
  name: string
  type: string
  distance: EveDistance | null
  distanceText: string
  lineNumber: number
}

export interface DscanTypeNameRequest {
  typeIds: number[]
}

/** Minimal, public ESI projection safe to expose to the renderer. */
export interface DscanTypeName {
  typeId: number
  name: string
}

export interface ProbeRow {
  id: string
  group: string
  kind: ProbeResultKind
  type: string | null
  name: string | null
  signal: number | null
  signalText: string
  distance: EveDistance | null
  distanceText: string
  lineNumber: number
}

export interface ClipboardParseResult<T> {
  rows: T[]
  rejected: number
}

export interface ClipboardDetection {
  kind: EveClipboardKind
  confidence: 'high' | 'medium' | 'low'
  rowCount: number
}

export type DscanShipRole =
  | 'logistics'
  | 'tackle'
  | 'ewar'
  | 'recon'
  | 'scanner'
  | 'command'
  | 'capital'
  | 'hauler'
  | 'mining'

export interface DscanRoleSummary {
  counts: Record<DscanShipRole, number>
  /** Rows matched by at least one exact hull-name rule. */
  matched: number
  /** Includes structures, drones, and hulls without an explicit rule. */
  unclassified: number
  ships: Partial<Record<DscanShipRole, string[]>>
}

const UNAVAILABLE_VALUE = /^(?:-|--|—|n\/?a)$/i
const PROBE_ID = /^[A-Z]{3}-\d{3}$/i
const NUMBER_PREFIX = /^([+-]?\d[\d\s\u00a0\u202f.,'’]*)\s*([^\d\s].*)$/u

const HEADER_WORDS = {
  name: new Set(['name', 'object', 'имя', 'название', 'объект']),
  type: new Set(['type', 'тип']),
  distance: new Set(['distance', 'range', 'расстояние', 'дальность']),
  id: new Set(['id', 'identifier', 'ид', 'идентификатор']),
  group: new Set(['group', 'группа']),
  signal: new Set([
    'signal',
    'signal strength',
    'strength',
    'сигнал',
    'сила сигнала',
    'уровень сигнала',
  ]),
}

const DISTANCE_UNITS: Record<string, EveDistanceUnit> = {
  m: 'm',
  meter: 'm',
  meters: 'm',
  metre: 'm',
  metres: 'm',
  м: 'm',
  метр: 'm',
  метра: 'm',
  метров: 'm',
  km: 'km',
  kilometer: 'km',
  kilometers: 'km',
  kilometre: 'km',
  kilometres: 'km',
  км: 'km',
  километр: 'km',
  километра: 'km',
  километров: 'km',
  au: 'au',
  ua: 'au',
  ae: 'au',
  ае: 'au',
}

const METERS_PER_UNIT: Record<EveDistanceUnit, number> = {
  m: 1,
  km: 1_000,
  au: 149_597_870_700,
}

function cleanCell(value: string): string {
  return value
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u202f]/g, ' ')
    .trim()
    .replace(/[ \v\f]+/g, ' ')
}

function normalizedLabel(value: string): string {
  return cleanCell(value).toLocaleLowerCase('en-US').replace(/:$/, '')
}

function splitRows(rawText: string): Array<{ line: string; lineNumber: number }> {
  if (typeof rawText !== 'string' || rawText.length === 0) return []

  return rawText
    .split(/\r\n?|\n/)
    .map((line, index) => ({ line: line.replace(/\ufeff/g, ''), lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
}

function splitClipboardColumns(line: string): string[] {
  return line.split('\t').map(cleanCell)
}

/** Parse EVE distance text while retaining the exact display value. */
export function parseEveDistance(rawValue: string): EveDistance | null {
  const text = cleanCell(rawValue)
  if (!text || UNAVAILABLE_VALUE.test(text)) return null

  const match = NUMBER_PREFIX.exec(text)
  if (!match) return null

  const unitKey = match[2]
    .toLocaleLowerCase('en-US')
    .replace(/[.\s]/g, '')
  const unit = DISTANCE_UNITS[unitKey]
  if (!unit) return null

  // AU values commonly carry three decimal places; treating that separator as
  // a thousands mark would turn a normal probe range into an impossible one.
  const value = parseLocalizedNumber(match[1], unit === 'au')
  if (value === null || value < 0) return null

  return {
    text,
    value,
    unit,
    meters: value * METERS_PER_UNIT[unit],
  }
}

function parseLocalizedNumber(rawValue: string, preferSingleSeparatorAsDecimal = false): number | null {
  let value = rawValue.replace(/[\s\u00a0\u202f'’]/g, '')
  const lastComma = value.lastIndexOf(',')
  const lastDot = value.lastIndexOf('.')

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.'
    const groupingSeparator = decimalSeparator === ',' ? /\./g : /,/g
    value = value.replace(groupingSeparator, '').replace(decimalSeparator, '.')
  } else {
    const separator = lastComma >= 0 ? ',' : lastDot >= 0 ? '.' : null
    if (separator) {
      const parts = value.split(separator)
      const looksGrouped = parts.length > 2
        ? parts.slice(1).every((part) => part.length === 3)
        : !preferSingleSeparatorAsDecimal &&
          parts.length === 2 &&
          parts[1].length === 3 &&
          parts[0].length <= 3

      value = looksGrouped
        ? parts.join('')
        : `${parts.slice(0, -1).join('')}.${parts.at(-1) ?? ''}`
    }
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isDscanHeader(fields: string[]): boolean {
  const labels = fields.map(normalizedLabel)
  return (
    labels.some((label) => HEADER_WORDS.name.has(label)) &&
    labels.some((label) => HEADER_WORDS.type.has(label)) &&
    labels.some((label) => HEADER_WORDS.distance.has(label))
  )
}

function isProbeHeader(fields: string[]): boolean {
  const labels = fields.map(normalizedLabel)
  return (
    labels.some((label) => HEADER_WORDS.id.has(label)) &&
    labels.some((label) => HEADER_WORDS.group.has(label)) &&
    labels.some((label) => HEADER_WORDS.signal.has(label))
  )
}

function distanceFieldIndex(fields: string[], fromIndex = 0): number {
  for (let index = fields.length - 1; index >= fromIndex; index -= 1) {
    if (parseEveDistance(fields[index]) || UNAVAILABLE_VALUE.test(fields[index])) return index
  }
  return -1
}

function positiveSafeInteger(rawValue: string): number | null {
  if (!/^\d+$/.test(rawValue)) return null
  const value = Number(rawValue)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** Parse rows copied from EVE's Directional Scanner. */
export function parseDscanClipboard(rawText: string): ClipboardParseResult<DscanRow> {
  const rows: DscanRow[] = []
  let rejected = 0

  for (const { line, lineNumber } of splitRows(rawText)) {
    const fields = splitClipboardColumns(line)
    if (isDscanHeader(fields)) continue
    if (fields.length < 3) {
      rejected += 1
      continue
    }

    const distanceIndex = distanceFieldIndex(fields, 2)
    if (distanceIndex < 2) {
      rejected += 1
      continue
    }

    let values = fields.slice(0, distanceIndex).filter(Boolean)
    let typeId: number | null = null

    // EVE's native three-column D-scan clipboard rows are
    // `<inventory type ID>\t<display/custom name>\t<distance>`. The display name
    // is the best local fallback until the official English type name is resolved.
    if (values.length === 2) {
      typeId = positiveSafeInteger(values[0])
      if (typeId !== null) values = [values[1], values[1]]
    }

    // Some four-column exports prepend an internal item ID. They already include
    // an explicit type name, so retain the existing behavior and ignore the ID.
    if (values.length >= 3 && positiveSafeInteger(values[0]) !== null) values = values.slice(1)

    const [name, type] = values
    if (!name || !type) {
      rejected += 1
      continue
    }

    const distanceText = fields[distanceIndex]
    rows.push({
      typeId,
      name,
      type,
      distance: parseEveDistance(distanceText),
      distanceText,
      lineNumber,
    })
  }

  return { rows, rejected }
}

export function parseDscanRows(rawText: string): DscanRow[] {
  return parseDscanClipboard(rawText).rows
}

/** Collect unique, valid type IDs in first-seen order for one bounded IPC request. */
export function collectDscanTypeIds(rows: readonly DscanRow[]): number[] {
  const result: number[] = []
  const seen = new Set<number>()

  for (const row of rows) {
    const typeId = row.typeId
    if (typeId === null || !Number.isSafeInteger(typeId) || typeId <= 0 || seen.has(typeId)) {
      continue
    }
    seen.add(typeId)
    result.push(typeId)
  }

  return result
}

/** Return enriched copies while retaining the custom/object name from D-scan. */
export function enrichDscanRows(
  rows: readonly DscanRow[],
  resolvedTypes: readonly DscanTypeName[],
): DscanRow[] {
  const namesByTypeId = new Map(
    resolvedTypes
      .filter(({ typeId, name }) => Number.isSafeInteger(typeId) && typeId > 0 && name.trim())
      .map(({ typeId, name }) => [typeId, name.trim()] as const),
  )

  return rows.map((row) => {
    const resolvedName = row.typeId === null ? undefined : namesByTypeId.get(row.typeId)
    return resolvedName ? { ...row, type: resolvedName } : { ...row }
  })
}

function probeResultKind(group: string): ProbeResultKind {
  const normalized = normalizedLabel(group)
  if (
    /(?:signature|signatur|sigнатур|firma|assinatura)/iu.test(normalized) ||
    normalized.includes('сигнатур')
  ) {
    return 'signature'
  }

  if (/(?:anomaly|anomalie|anomalía|anomalia)/iu.test(normalized) || normalized.includes('аномал')) {
    return 'anomaly'
  }

  return 'unknown'
}

function parseSignal(rawValue: string): number | null {
  const text = cleanCell(rawValue)
  if (!text || UNAVAILABLE_VALUE.test(text)) return null
  const match = /^([+-]?[\d\s.,]+)\s*%$/.exec(text)
  if (!match) return null
  const value = parseLocalizedNumber(match[1], true)
  return value !== null && value >= 0 && value <= 100 ? value : null
}

/** Parse Cosmic Signature and Cosmic Anomaly rows copied from Probe Scanner. */
export function parseProbeClipboard(rawText: string): ClipboardParseResult<ProbeRow> {
  const rows: ProbeRow[] = []
  let rejected = 0

  for (const { line, lineNumber } of splitRows(rawText)) {
    const fields = splitClipboardColumns(line)
    if (isProbeHeader(fields)) continue
    if (fields.length < 5) {
      rejected += 1
      continue
    }

    const idIndex = fields.findIndex((field) => PROBE_ID.test(field))
    if (idIndex < 0 || fields.length - idIndex < 5) {
      rejected += 1
      continue
    }

    const id = fields[idIndex].toUpperCase()
    const group = fields[idIndex + 1]
    const type = fields[idIndex + 2] || null
    const name = fields[idIndex + 3] || null
    const signalText = fields[idIndex + 4]
    const signal = parseSignal(signalText)
    const distanceIndex = distanceFieldIndex(fields, idIndex + 5)
    const distanceText = distanceIndex >= 0 ? fields[distanceIndex] : ''

    if (!group || probeResultKind(group) === 'unknown' || (signal === null && !UNAVAILABLE_VALUE.test(signalText))) {
      rejected += 1
      continue
    }

    rows.push({
      id,
      group,
      kind: probeResultKind(group),
      type,
      name,
      signal,
      signalText,
      distance: distanceIndex >= 0 ? parseEveDistance(distanceText) : null,
      distanceText,
      lineNumber,
    })
  }

  return { rows, rejected }
}

export function parseProbeRows(rawText: string): ProbeRow[] {
  return parseProbeClipboard(rawText).rows
}

/**
 * Detect supported EVE clipboard formats. Probe runs before D-scan because both
 * contain a distance column; Local requires at least two plausible roster rows.
 */
export function classifyEveClipboard(rawText: string): ClipboardDetection {
  const nonEmptyLines = splitRows(rawText).length
  if (nonEmptyLines === 0) return { kind: 'unknown', confidence: 'high', rowCount: 0 }

  const probe = parseProbeClipboard(rawText)
  if (probe.rows.length > 0) {
    return {
      kind: 'probe',
      confidence: probe.rejected === 0 ? 'high' : 'medium',
      rowCount: probe.rows.length,
    }
  }

  const dscan = parseDscanClipboard(rawText)
  if (dscan.rows.length > 0) {
    return {
      kind: 'dscan',
      confidence: dscan.rejected === 0 ? 'high' : 'medium',
      rowCount: dscan.rows.length,
    }
  }

  const local = parseLocalRoster(rawText)
  if (local.names.length >= 2 && local.names.length + local.rejected === nonEmptyLines) {
    const validRatio = local.names.length / nonEmptyLines
    if (validRatio >= 0.75) {
      return {
        kind: 'local',
        confidence: validRatio === 1 ? 'high' : 'medium',
        rowCount: local.names.length,
      }
    }
  }

  return { kind: 'unknown', confidence: 'low', rowCount: 0 }
}

export function detectClipboardKind(rawText: string): EveClipboardKind {
  return classifyEveClipboard(rawText).kind
}

const ROLE_SHIPS: Record<DscanShipRole, ReadonlySet<string>> = {
  logistics: shipSet([
    'Bantam', 'Burst', 'Navitas', 'Inquisitor', 'Kirin', 'Scalpel', 'Thalia', 'Deacon',
    'Osprey', 'Scythe', 'Exequror', 'Augoror', 'Basilisk', 'Scimitar', 'Oneiros',
    'Guardian', 'Rodiva', 'Zarmazd', 'Etana', 'Rabisu', 'Nestor', 'Apostle',
    'Minokawa', 'Ninazu', 'Lif', 'Dagon', 'Loggerhead', 'Venerable',
  ]),
  tackle: shipSet([
    'Ares', 'Taranis', 'Malediction', 'Crusader', 'Crow', 'Raptor', 'Stiletto', 'Claw',
    'Eris', 'Heretic', 'Flycatcher', 'Sabre', 'Phobos', 'Devoter', 'Onyx', 'Broadsword',
  ]),
  ewar: shipSet([
    'Griffin', 'Kitsune', 'Blackbird', 'Scorpion', 'Maulus', 'Keres', 'Celestis',
    'Crucifier', 'Sentinel', 'Arbitrator', 'Vigil', 'Hyena', 'Bellicose',
  ]),
  recon: shipSet(['Falcon', 'Rook', 'Arazu', 'Lachesis', 'Pilgrim', 'Curse', 'Rapier', 'Huginn']),
  scanner: shipSet([
    'Heron', 'Buzzard', 'Probe', 'Cheetah', 'Imicus', 'Helios', 'Magnate', 'Anathema',
    'Astero', 'AIR Civilian Astero', 'Stratios', 'Stratios Emergency Responder',
    'Metamorphosis', 'Echelon', 'Zephyr', 'Odysseus', 'Probe Fleet Issue',
    'Heron Navy Issue', 'Magnate Navy Issue', 'Imicus Navy Issue',
  ]),
  command: shipSet([
    'Stork', 'Bifrost', 'Magus', 'Pontifex', 'Vulture', 'Nighthawk', 'Sleipnir', 'Claymore',
    'Astarte', 'Eos', 'Absolution', 'Damnation', 'Draugur', 'Outrider', 'Odysseus',
    'Salvation', 'Simurgh', 'Gaia', 'Ymir',
  ]),
  capital: shipSet([
    'Archon', 'Chimera', 'Thanatos', 'Nidhoggur', 'Apostle', 'Minokawa', 'Ninazu', 'Lif',
    'Revelation', 'Phoenix', 'Moros', 'Naglfar', 'Revelation Navy Issue', 'Phoenix Navy Issue',
    'Moros Navy Issue', 'Naglfar Fleet Issue', 'Bane', 'Karura', 'Hubris', 'Valravn',
    'Aeon', 'Wyvern', 'Nyx', 'Hel', 'Avatar', 'Leviathan', 'Erebus', 'Ragnarok',
    'Revenant', 'Vendetta', 'Vanquisher', 'Molok', 'Komodo', 'Azariel', 'Vehement',
    'Chemosh', 'Caiman', 'Zirnitra', 'Sarathiel', 'Dagon', 'Loggerhead', 'Salvation',
    'Simurgh', 'Gaia', 'Ymir', 'Rorqual',
  ]),
  hauler: shipSet([
    'Badger', 'Tayra', 'Wreathe', 'Mammoth', 'Hoarder', 'Nereus', 'Kryos', 'Miasmos',
    'Epithal', 'Iteron Mark V', 'Sigil', 'Bestower', 'Crane', 'Bustard', 'Prowler',
    'Mastodon', 'Viator', 'Occator', 'Prorator', 'Impel', 'Charon', 'Fenrir', 'Obelisk',
    'Providence', 'Rhea', 'Nomad', 'Anshar', 'Ark', 'Bowhead', 'Primae', 'Noctis',
    'Squall', 'Torrent', 'Avalanche', 'Deluge', 'Miasmos Quafe Ultra Edition',
    'Miasmos Quafe Ultramarine Edition', 'Miasmos Amastris Edition',
  ]),
  mining: shipSet([
    'Venture', 'Prospect', 'Endurance', 'Procurer', 'Retriever', 'Covetor', 'Skiff',
    'Mackinaw', 'Hulk', 'Porpoise', 'Orca', 'Rorqual', 'Citizen Venture',
    'Venture Consortium Issue', 'Pioneer', 'Pioneer Consortium Issue', 'Perseverance',
  ]),
}

function shipSet(names: string[]): ReadonlySet<string> {
  return new Set(names.map(normalizeShipType))
}

function normalizeShipType(typeName: string): string {
  return cleanCell(typeName).toLocaleLowerCase('en-US')
}

/** Exact English type-name lookup. Custom object names are deliberately ignored. */
export function classifyDscanShipRoles(typeName: string): DscanShipRole[] {
  const normalized = normalizeShipType(typeName)
  if (!normalized) return []

  return (Object.keys(ROLE_SHIPS) as DscanShipRole[]).filter((role) => ROLE_SHIPS[role].has(normalized))
}

export function summarizeDscanRoles(rows: readonly DscanRow[]): DscanRoleSummary {
  const roles = Object.keys(ROLE_SHIPS) as DscanShipRole[]
  const counts = Object.fromEntries(roles.map((role) => [role, 0])) as Record<DscanShipRole, number>
  const ships: Partial<Record<DscanShipRole, string[]>> = {}
  let matched = 0

  for (const row of rows) {
    const rowRoles = classifyDscanShipRoles(row.type)
    if (rowRoles.length === 0) continue
    matched += 1

    for (const role of rowRoles) {
      counts[role] += 1
      ;(ships[role] ??= []).push(row.type)
    }
  }

  return {
    counts,
    matched,
    unclassified: rows.length - matched,
    ships,
  }
}
