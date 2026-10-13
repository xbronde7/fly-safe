import { afterEach, describe, expect, it, vi } from 'vitest'
import { Cache } from '../src/main/cache'
import { EsiClient } from '../src/main/esi-client'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('EsiClient solar-system resolution', () => {
  let cache: Cache | null = null

  afterEach(() => {
    cache?.close()
    cache = null
  })

  it('resolves exact system names and caches positive and negative results', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const names = JSON.parse(String(init?.body)) as string[]
      return jsonResponse(
        names[0]?.toUpperCase() === 'J123456'
          ? { systems: [{ id: 31_000_001, name: 'J123456' }] }
          : { systems: [] }
      )
    })
    cache = new Cache(':memory:')
    const esi = new EsiClient(cache, {
      baseUrl: 'https://esi.test',
      fetch: fetchMock,
      maxAttempts: 1
    })

    await expect(esi.resolveSolarSystemId(' j123456 ')).resolves.toEqual({
      id: 31_000_001,
      name: 'J123456',
      cached: false
    })
    await expect(esi.resolveSolarSystemId('J123456')).resolves.toEqual({
      id: 31_000_001,
      name: 'J123456',
      cached: true
    })
    await expect(esi.resolveSolarSystemId('Not A System')).resolves.toBeNull()
    await expect(esi.resolveSolarSystemId('not a system')).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
