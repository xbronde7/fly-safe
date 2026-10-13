import type { DscanTypeName, DscanTypeNameRequest } from '../shared/clipboard-intel'
import type { UniverseName } from './esi-client'

const MAX_TYPE_IDS_PER_REQUEST = 1_000
const REQUEST_KEYS = new Set<PropertyKey>(['typeIds'])

/** Strictly validate the renderer-controlled D-scan type resolution request. */
export function parseDscanTypeNameRequest(value: unknown): DscanTypeNameRequest {
  if (!isRecord(value)) throw new TypeError('Invalid D-scan type request')

  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 1 ||
    keys.some((key) => !REQUEST_KEYS.has(key)) ||
    !Object.prototype.hasOwnProperty.call(value, 'typeIds')
  ) {
    throw new TypeError('D-scan type request contains unknown or missing fields')
  }

  const rawTypeIds = value.typeIds
  if (
    !Array.isArray(rawTypeIds) ||
    rawTypeIds.length < 1 ||
    rawTypeIds.length > MAX_TYPE_IDS_PER_REQUEST
  ) {
    throw new RangeError(`typeIds must contain from 1 to ${MAX_TYPE_IDS_PER_REQUEST} IDs`)
  }

  const typeIds: number[] = []
  for (let index = 0; index < rawTypeIds.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(rawTypeIds, index)) {
      throw new TypeError('typeIds must not contain empty entries')
    }

    const typeId = rawTypeIds[index]
    if (!Number.isSafeInteger(typeId) || (typeId as number) <= 0) {
      throw new TypeError('typeIds must contain positive safe-integer IDs')
    }
    typeIds.push(typeId as number)
  }

  if (new Set(typeIds).size !== typeIds.length) {
    throw new TypeError('typeIds must contain unique IDs')
  }

  return { typeIds }
}

/**
 * Project ESI's internal/cache-aware records onto the only fields the renderer
 * needs. Non-inventory and unrequested records cannot cross the IPC boundary.
 */
export function toPublicDscanTypeNames(
  request: DscanTypeNameRequest,
  universeNames: readonly Pick<UniverseName, 'id' | 'name' | 'category'>[],
): DscanTypeName[] {
  const requestedIds = new Set(request.typeIds)
  const namesById = new Map<number, string>()

  for (const entry of universeNames) {
    const name = entry.name.trim()
    if (
      entry.category !== 'inventory_type' ||
      !requestedIds.has(entry.id) ||
      !Number.isSafeInteger(entry.id) ||
      entry.id <= 0 ||
      !name ||
      namesById.has(entry.id)
    ) {
      continue
    }
    namesById.set(entry.id, name)
  }

  return request.typeIds.flatMap((typeId) => {
    const name = namesById.get(typeId)
    return name ? [{ typeId, name }] : []
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
