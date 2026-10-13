import { classifyDscanShipRoles } from './clipboard-intel'

export type TargetCategory =
  | 'scanner'
  | 'logistics'
  | 'mining'
  | 'hauler'
  | 'pve'
  | 'combat'
  | 'capital'
  | 'structure'
  | 'other'

export interface TargetProfileEntry {
  category: TargetCategory
  label: string
  kills: number
  /** Portion of total kills, from 0 to 1. */
  share: number
}

export interface TargetProfile {
  totalKills: number
  /** Kills assigned to a meaningful category; `other` and missing rows are excluded. */
  categorizedKills: number
  /** Stable category order; zero-value entries are retained for predictable UI. */
  entries: TargetProfileEntry[]
  /** Non-zero entries sorted by kill count, then by stable category order. */
  top: TargetProfileEntry[]
}

export interface RecentTargetObservation {
  shipName: string | null
  /** Victim hull type ID from the killmail, when available. */
  shipTypeId?: number | null
  /** Official inventory group ID for the victim hull, when already resolved. */
  groupId?: number | null
}

interface CategoryDefinition {
  category: TargetCategory
  label: string
  /** Unambiguous inventory groups safe to use in aggregate lifetime statistics. */
  groupIds: readonly number[]
}

/*
 * Group IDs come from the official EVE SDE. Classification is deliberately
 * approximate: zKill aggregates victims by ship group, so mixed groups such as
 * Frigate, Cruiser, Battleship, and Destroyer cannot be assigned a role here.
 * Exact recent killmails handle those groups separately below.
 */
const CATEGORY_DEFINITIONS: readonly CategoryDefinition[] = [
  {
    category: 'scanner',
    label: 'Scouts',
    // Prototype Exploration Ship, Expedition Command Ship. Covert Ops is mixed.
    groupIds: [1022, 4902],
  },
  {
    category: 'logistics',
    label: 'Logistics',
    // Logistics, Logistics Frigate, Force Auxiliary.
    groupIds: [832, 1527, 1538],
  },
  {
    category: 'mining',
    label: 'Mining',
    // Mining Barge, Exhumer, industrial command/capital, expedition frigates.
    groupIds: [463, 543, 883, 941, 1283],
  },
  {
    category: 'hauler',
    label: 'Haulers',
    // Hauler, Deep Space Transport, Freighter, Jump Freighter, Blockade Runner.
    groupIds: [28, 380, 513, 902, 1202],
  },
  {
    category: 'pve',
    label: 'PvE',
    // Marauder is the only dedicated PvE-heavy group identifiable at group level.
    groupIds: [900],
  },
  {
    category: 'combat',
    label: 'Combat',
    groupIds: [
      324, 358, 419, 540, 541, 831, 833, 834, 893, 894, 898, 906, 1201, 1305,
      1534, 1972,
    ],
  },
  {
    category: 'capital',
    label: 'Capitals',
    // Titan, Dreadnought, Carrier, Supercarrier, Lancer Dreadnought, Command Carrier.
    groupIds: [30, 485, 547, 659, 4594, 5120],
  },
  {
    category: 'structure',
    label: 'Structures',
    // Deployables, starbases, sovereignty/orbital and Upwell structures.
    groupIds: [
      311, 361, 363, 364, 365, 397, 404, 413, 414, 416, 417, 418, 426, 430,
      438, 439, 440, 441, 443, 444, 445, 449, 471, 473, 480, 707, 709, 710,
      837, 838, 839, 840, 877, 1003, 1004, 1005, 1012, 1025, 1073, 1106, 1149,
      1212, 1246, 1247, 1249, 1250, 1273, 1274, 1275, 1276, 1282, 1297, 1312,
      1404, 1405, 1406, 1407, 1408, 1409, 1410, 1657, 1876, 1924, 2005, 2015,
      2016, 2017, 4093, 4107, 4137, 4477, 4499, 4644, 4736, 4744, 4810, 4913,
    ],
  },
  {
    category: 'other',
    label: 'Other',
    // Capsule, Shuttle, Corvette, retired Elite Battleship, Special Edition Yachts.
    groupIds: [29, 31, 237, 381, 2001, 5087],
  },
]

const CATEGORY_BY_GROUP_ID = new Map<number, TargetCategory>(
  CATEGORY_DEFINITIONS.flatMap(({ category, groupIds }) =>
    groupIds.map((groupId) => [groupId, category] as const),
  ),
)

/*
 * These current ship groups contain both ordinary combat hulls and specialist
 * exceptions. Aggregate zKill rows remain `other`; exact recent observations
 * classify known exceptions first and use combat only for the remaining hulls.
 */
const MIXED_COMBAT_GROUP_IDS = new Set([25, 26, 27, 420])

interface ExactTargetDefinition {
  category: TargetCategory
  /** Stable inventory type IDs from the official EVE SDE/ESI. */
  typeIds: readonly number[]
  /** Exact English inventory type names returned by ESI. */
  names: readonly string[]
}

/*
 * Type-level fallbacks are useful for hulls that share a generic group but have
 * a distinct role (Astero and Rifter are both Frigates, group 25). Most hulls
 * should still be classified by group ID when the caller has resolved it.
 */
const EXACT_TARGET_DEFINITIONS: readonly ExactTargetDefinition[] = [
  {
    category: 'scanner',
    typeIds: [
      586, 605, 607, 3532, 11172, 11182, 11188, 11192, 29248, 33468, 33470,
      33553, 58745, 72903, 72904, 72907, 72913, 77114,
    ],
    names: [
      'Probe', 'Heron', 'Imicus', 'Echelon', 'Helios', 'Cheetah', 'Anathema',
      'Buzzard', 'Magnate', 'Astero', 'Stratios', 'Stratios Emergency Responder',
      'AIR Civilian Astero', 'Probe Fleet Issue', 'Heron Navy Issue',
      'Magnate Navy Issue', 'Imicus Navy Issue', 'Metamorphosis',
    ],
  },
  {
    category: 'logistics',
    typeIds: [
      582, 590, 592, 599, 620, 625, 631, 634, 11987, 33472, 37604, 37605,
      37606, 37607, 42242, 45645, 49712,
    ],
    names: [
      'Bantam', 'Inquisitor', 'Navitas', 'Burst', 'Osprey', 'Augoror', 'Scythe',
      'Exequror', 'Guardian', 'Nestor', 'Apostle', 'Minokawa', 'Lif', 'Ninazu',
      'Dagon', 'Loggerhead', 'Rodiva',
    ],
  },
  {
    category: 'mining',
    typeIds: [22544, 32880, 48648, 89240, 89647, 89648, 91174],
    names: [
      'Hulk', 'Venture', 'Citizen Venture', 'Pioneer', 'Pioneer Consortium Issue',
      'Venture Consortium Issue', 'Perseverance',
    ],
  },
  {
    category: 'hauler',
    typeIds: [2863, 2998, 20183],
    names: ['Primae', 'Noctis', 'Providence'],
  },
  {
    category: 'pve',
    typeIds: [28659, 28661, 28665, 28710, 88001],
    names: ['Paladin', 'Kronos', 'Vargur', 'Golem', 'Babaroga'],
  },
  {
    category: 'combat',
    typeIds: [587, 33397, 42246, 44993, 48636, 85062],
    names: ['Rifter', 'Chremoas', 'Caedes', 'Pacifier', 'Hydra', 'Sidewinder'],
  },
  {
    category: 'capital',
    typeIds: [19720],
    names: ['Revelation'],
  },
  {
    category: 'structure',
    typeIds: [35825, 35826, 35827, 35832, 35833, 35834, 35835, 35836],
    names: [
      'Raitaru', 'Azbel', 'Sotiyo', 'Astrahus', 'Fortizar', 'Keepstar', 'Athanor',
      'Tatara',
    ],
  },
  {
    category: 'other',
    typeIds: [670],
    names: ['Capsule'],
  },
]

const CATEGORY_BY_SHIP_TYPE_ID = new Map<number, TargetCategory>(
  EXACT_TARGET_DEFINITIONS.flatMap(({ category, typeIds }) =>
    typeIds.map((typeId) => [typeId, category] as const),
  ),
)

const CATEGORY_BY_EXACT_SHIP_NAME = new Map<string, TargetCategory>(
  EXACT_TARGET_DEFINITIONS.flatMap(({ category, names }) =>
    names.map((name) => [normalizeTargetName(name), category] as const),
  ),
)

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const normalized = typeof value === 'string' ? value.trim().replaceAll(',', '') : value
  if (normalized === '') return null

  const parsed = typeof normalized === 'number' ? normalized : Number(normalized)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.floor(parsed)
}

function positiveInteger(value: unknown): number | null {
  const parsed = nonNegativeInteger(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function rawEntries(rawGroups: unknown): Array<[string, unknown]> {
  if (Array.isArray(rawGroups)) {
    return rawGroups.map((value, index) => [String(index), value])
  }

  return Object.entries(asRecord(rawGroups) ?? {})
}

/** Build a coarse victim profile from the untrusted `groups` section of zKill stats. */
export function buildTargetProfile(rawGroups: unknown, totalKills?: unknown): TargetProfile {
  const killsByCategory = new Map<TargetCategory, number>(
    CATEGORY_DEFINITIONS.map(({ category }) => [category, 0]),
  )

  let parsedKills = 0
  let categorizedKills = 0

  for (const [key, value] of rawEntries(rawGroups)) {
    const row = asRecord(value)
    if (!row) continue

    const kills = nonNegativeInteger(row.shipsDestroyed)
    if (kills === null) continue

    const groupId = positiveInteger(row.groupID) ?? positiveInteger(key)
    const category =
      (groupId === null ? undefined : CATEGORY_BY_GROUP_ID.get(groupId)) ?? 'other'

    killsByCategory.set(category, (killsByCategory.get(category) ?? 0) + kills)
    parsedKills += kills
    if (category !== 'other') categorizedKills += kills
  }

  const explicitTotal = nonNegativeInteger(totalKills)
  return buildProfileFromCategoryCounts(
    killsByCategory,
    Math.max(explicitTotal ?? 0, parsedKills),
    categorizedKills,
  )
}

function buildProfileFromCategoryCounts(
  killsByCategory: ReadonlyMap<TargetCategory, number>,
  totalKills: number,
  categorizedKills: number,
): TargetProfile {
  const entries = CATEGORY_DEFINITIONS.map(({ category, label }) => {
    const kills = killsByCategory.get(category) ?? 0
    return {
      category,
      label,
      kills,
      share: totalKills === 0 ? 0 : kills / totalKills,
    }
  })
  const categoryOrder = new Map(
    CATEGORY_DEFINITIONS.map(({ category }, index) => [category, index]),
  )
  const top = entries
    .filter(({ kills }) => kills > 0)
    .sort(
      (left, right) =>
        right.kills - left.kills ||
        (categoryOrder.get(left.category) ?? 0) - (categoryOrder.get(right.category) ?? 0),
    )

  return { totalKills, categorizedKills, entries, top }
}

/**
 * Build a deliberately coarse fallback from the victim hulls present in recent
 * public killmails. This is used when zKill has no standalone stats profile
 * (notably for NPC/Drifter attackers). It is not a lifetime profile.
 */
export function buildRecentTargetProfile(
  observations: readonly RecentTargetObservation[]
): TargetProfile {
  const killsByCategory = new Map<TargetCategory, number>(
    CATEGORY_DEFINITIONS.map(({ category }) => [category, 0]),
  )
  let categorizedKills = 0

  for (const observation of observations) {
    const category = classifyRecentTargetObservation(observation)
    killsByCategory.set(category, (killsByCategory.get(category) ?? 0) + 1)
    if (category !== 'other') categorizedKills += 1
  }

  return buildProfileFromCategoryCounts(
    killsByCategory,
    observations.length,
    categorizedKills,
  )
}

/**
 * Classify the destroyed hull represented by a recent killmail.
 *
 * The observation must describe the victim, not the watched pilot's attacker
 * hull. Exact type/name metadata handles role-specific hulls inside mixed
 * groups; only role-safe groups are used as a fallback.
 */
export function classifyRecentTargetObservation(
  observation: RecentTargetObservation,
): TargetCategory {
  const shipTypeId = positiveSafeInteger(observation.shipTypeId)
  const typeCategory = shipTypeId === null
    ? undefined
    : CATEGORY_BY_SHIP_TYPE_ID.get(shipTypeId)
  if (typeCategory) return typeCategory

  const shipName = normalizeTargetName(observation.shipName)
  if (/^(?:capsule|pod|unknown|неизвест)/iu.test(shipName)) return 'other'
  const exactCategory = CATEGORY_BY_EXACT_SHIP_NAME.get(shipName)
  if (exactCategory) return exactCategory

  const groupId = positiveSafeInteger(observation.groupId)
  const groupCategory = groupId === null ? undefined : CATEGORY_BY_GROUP_ID.get(groupId)
  if (groupCategory) return groupCategory

  const roles = classifyDscanShipRoles(shipName)
  if (roles.includes('scanner')) return 'scanner'
  if (roles.includes('logistics')) return 'logistics'
  if (roles.includes('mining')) return 'mining'
  if (roles.includes('hauler')) return 'hauler'
  if (roles.includes('capital')) return 'capital'
  if (roles.some((role) => ['tackle', 'ewar', 'recon', 'command'].includes(role))) {
    return 'combat'
  }
  if (groupId !== null && MIXED_COMBAT_GROUP_IDS.has(groupId)) return 'combat'
  return 'other'
}

function positiveSafeInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null
}

function normalizeTargetName(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('en-US') : ''
}

export type TargetProfileSource = 'lifetime' | 'recent' | 'none'

export interface TargetProfileSelection {
  profile: TargetProfile | null
  source: TargetProfileSource
}

/** Prefer exact recent evidence only when it represents the full lifetime total. */
export function selectTargetProfile(
  lifetime: TargetProfile | null | undefined,
  recent: TargetProfile | null | undefined,
  recentComplete: boolean,
): TargetProfileSelection {
  if (recent && (!lifetime || (recentComplete && recent.totalKills === lifetime.totalKills))) {
    return { profile: recent, source: 'recent' }
  }
  if (lifetime) return { profile: lifetime, source: 'lifetime' }
  if (recent) return { profile: recent, source: 'recent' }
  return { profile: null, source: 'none' }
}
