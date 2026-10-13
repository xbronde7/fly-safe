export type FitSection =
  | 'high'
  | 'medium'
  | 'low'
  | 'rig'
  | 'subsystem'
  | 'drone'
  | 'fighter'
  | 'cargo'
  | 'other'

export interface FitItem {
  typeId: number
  name?: string
  quantityDestroyed: number
  quantityDropped: number
  section: FitSection
}

export interface ShipFit {
  shipTypeId: number
  shipName?: string
  sections: Record<FitSection, FitItem[]>
  totalDestroyed: number
  totalDropped: number
}

type UnknownRecord = Record<string, unknown>
type TypeNames = Map<number, string> | Record<string, string>

const SECTION_ORDER: readonly FitSection[] = [
  'high',
  'medium',
  'low',
  'rig',
  'subsystem',
  'drone',
  'fighter',
  'cargo',
  'other',
]

const MAX_ITEM_DEPTH = 16
const MAX_ITEMS = 20_000

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

function nonNegativeInteger(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function typeName(names: TypeNames | undefined, typeId: number): string | undefined {
  if (!names) return undefined

  const value =
    names instanceof Map
      ? names.get(typeId)
      : Object.prototype.hasOwnProperty.call(names, String(typeId))
        ? names[String(typeId)]
        : undefined

  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function emptySections(): Record<FitSection, FitItem[]> {
  return {
    high: [],
    medium: [],
    low: [],
    rig: [],
    subsystem: [],
    drone: [],
    fighter: [],
    cargo: [],
    other: [],
  }
}

function safeAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

interface RawItemVisit {
  item: UnknownRecord
  depth: number
}

function visitVictimItems(victim: UnknownRecord, callback: (item: UnknownRecord) => void): void {
  if (!Array.isArray(victim.items)) return

  const stack: RawItemVisit[] = victim.items
    .slice()
    .reverse()
    .flatMap((value) => {
      const item = asRecord(value)
      return item ? [{ item, depth: 0 }] : []
    })
  const visited = new WeakSet<object>()
  let visits = 0

  while (stack.length > 0 && visits < MAX_ITEMS) {
    const next = stack.pop()
    if (!next || visited.has(next.item)) continue

    visited.add(next.item)
    visits += 1
    callback(next.item)

    if (next.depth >= MAX_ITEM_DEPTH || !Array.isArray(next.item.items)) continue
    for (let index = next.item.items.length - 1; index >= 0; index -= 1) {
      const child = asRecord(next.item.items[index])
      if (child) stack.push({ item: child, depth: next.depth + 1 })
    }
  }
}

/** Convert an EVE inventory flag to the slot shown in the fit viewer. */
export function sectionForFlag(flag: number): FitSection {
  if (!Number.isInteger(flag)) return 'other'
  if (flag >= 11 && flag <= 18) return 'low'
  if (flag >= 19 && flag <= 26) return 'medium'
  if (flag >= 27 && flag <= 34) return 'high'
  if (flag >= 92 && flag <= 99) return 'rig'
  if (flag >= 125 && flag <= 132) return 'subsystem'
  if (flag === 87) return 'drone'
  if (flag === 158 || flag === 159) return 'fighter'
  if (flag === 5) return 'cargo'
  return 'other'
}

/** Collect unique type IDs needed to resolve ship and item names through ESI. */
export function collectKillmailTypeIds(rawKillmail: unknown): number[] {
  const killmail = asRecord(rawKillmail)
  const victim = killmail ? asRecord(killmail.victim) : null
  if (!victim) return []

  const ids = new Set<number>()
  const shipTypeId = positiveInteger(victim.ship_type_id)
  if (shipTypeId !== null) ids.add(shipTypeId)

  visitVictimItems(victim, (item) => {
    const typeId = positiveInteger(item.item_type_id)
    if (typeId !== null) ids.add(typeId)
  })

  return [...ids]
}

/** Parse the victim side of an untrusted ESI killmail into a display-ready ship fit. */
export function parseVictimFit(rawKillmail: unknown, names?: TypeNames): ShipFit | null {
  const killmail = asRecord(rawKillmail)
  const victim = killmail ? asRecord(killmail.victim) : null
  if (!victim) return null

  const shipTypeId = positiveInteger(victim.ship_type_id)
  if (shipTypeId === null) return null

  const sections = emptySections()
  const aggregated = new Map<string, FitItem>()
  let totalDestroyed = 0
  let totalDropped = 0

  visitVictimItems(victim, (rawItem) => {
    const typeId = positiveInteger(rawItem.item_type_id)
    if (typeId === null) return

    const rawFlag =
      typeof rawItem.flag === 'number'
        ? rawItem.flag
        : typeof rawItem.flag === 'string'
          ? Number(rawItem.flag)
          : NaN
    const section = sectionForFlag(rawFlag)
    const quantityDestroyed = nonNegativeInteger(rawItem.quantity_destroyed)
    const quantityDropped = nonNegativeInteger(rawItem.quantity_dropped)
    const key = `${section}:${typeId}`
    const existing = aggregated.get(key)

    totalDestroyed = safeAdd(totalDestroyed, quantityDestroyed)
    totalDropped = safeAdd(totalDropped, quantityDropped)

    if (existing) {
      existing.quantityDestroyed = safeAdd(existing.quantityDestroyed, quantityDestroyed)
      existing.quantityDropped = safeAdd(existing.quantityDropped, quantityDropped)
      return
    }

    const item: FitItem = {
      typeId,
      quantityDestroyed,
      quantityDropped,
      section,
    }
    const name = typeName(names, typeId)
    if (name !== undefined) item.name = name

    aggregated.set(key, item)
    sections[section].push(item)
  })

  // Keep section key order explicit for consumers serializing this object.
  const orderedSections = Object.fromEntries(
    SECTION_ORDER.map((section) => [section, sections[section]]),
  ) as Record<FitSection, FitItem[]>
  const fit: ShipFit = { shipTypeId, sections: orderedSections, totalDestroyed, totalDropped }
  const shipName = typeName(names, shipTypeId)
  if (shipName !== undefined) fit.shipName = shipName

  return fit
}
