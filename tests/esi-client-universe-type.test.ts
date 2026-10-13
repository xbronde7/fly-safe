import { describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { EsiClient } from '../src/main/esi-client'

const TYPE_ID = 33_468
const GROUP_ID = 25

describe('EsiClient universe type metadata', () => {
  it('returns base hull mass from the public route and serves a fresh cached value', async () => {
    const cache = new Cache(':memory:')
    const now = Date.now()
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`https://esi.test/universe/types/${TYPE_ID}/`)
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBeNull()
      expect(headers.get('X-Compatibility-Date')).toBe('2026-08-20')
      return jsonResponse(
        { type_id: TYPE_ID, name: 'Astero', group_id: GROUP_ID, mass: 1_150_000 },
        200,
        { 'Cache-Control': 'public, max-age=60', ETag: '"astero-v1"' }
      )
    })
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1,
      now: () => now
    })

    await expect(esi.getUniverseType(TYPE_ID)).resolves.toEqual({
      id: TYPE_ID,
      name: 'Astero',
      groupId: GROUP_ID,
      massKg: 1_150_000,
      cached: false
    })
    await expect(esi.getUniverseType(TYPE_ID)).resolves.toMatchObject({
      massKg: 1_150_000,
      cached: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cache.count()).toBe(1)
    cache.close()
  })

  it('revalidates stale metadata with ETag and keeps the cached value on 304', async () => {
    const cache = new Cache(':memory:')
    let now = 10_000
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      if (fetchMock.mock.calls.length === 1) {
        return jsonResponse(
          { type_id: TYPE_ID, name: 'Astero', group_id: GROUP_ID, mass: 1_150_000 },
          200,
          { 'Cache-Control': 'max-age=5', ETag: '"astero-v1"' }
        )
      }

      expect(new Headers(init?.headers).get('If-None-Match')).toBe('"astero-v1"')
      return new Response(null, {
        status: 304,
        headers: { 'Cache-Control': 'max-age=30', ETag: '"astero-v1"' }
      })
    })
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1,
      now: () => now
    })

    await expect(esi.getUniverseType(TYPE_ID)).resolves.toMatchObject({ cached: false })
    now += 5_001
    await expect(esi.getUniverseType(TYPE_ID)).resolves.toEqual({
      id: TYPE_ID,
      name: 'Astero',
      groupId: GROUP_ID,
      massKg: 1_150_000,
      cached: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    cache.close()
  })

  it('represents an omitted or unusable public mass as unknown', async () => {
    const cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      maxAttempts: 1,
      fetch: vi.fn<typeof fetch>(async () => jsonResponse({
        type_id: TYPE_ID,
        name: 'Astero',
        group_id: GROUP_ID
      }))
    })

    await expect(esi.getUniverseType(TYPE_ID)).resolves.toMatchObject({ massKg: null })
    await expect(esi.getUniverseType(0)).rejects.toThrow('Invalid universe type ID')
    cache.close()
  })
})

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}
