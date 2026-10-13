import { afterEach, describe, expect, it } from 'vitest'
import { Cache } from '../src/main/cache'

describe('Cache', () => {
  let cache: Cache | null = null

  afterEach(() => {
    cache?.close()
    cache = null
  })

  it('stores JSON values until their TTL expires', () => {
    cache = new Cache(':memory:')
    cache.set('pilots', '42', { name: 'Aura', active: true }, 1_000, 10_000)

    expect(cache.get<{ name: string; active: boolean }>('pilots', '42', 10_999)?.value)
      .toEqual({ name: 'Aura', active: true })
    expect(cache.get('pilots', '42', 11_000)).toBeNull()
    expect(cache.count()).toBe(0)
  })

  it('keeps equal keys isolated by namespace', () => {
    cache = new Cache(':memory:')
    cache.set('esi:name', '7', 'Minmatar', 10_000)
    cache.set('zkill:stats', '7', { shipsDestroyed: 12 }, 10_000)

    expect(cache.get<string>('esi:name', '7')?.value).toBe('Minmatar')
    expect(cache.get<{ shipsDestroyed: number }>('zkill:stats', '7')?.value)
      .toEqual({ shipsDestroyed: 12 })
    expect(cache.count()).toBe(2)
  })

  it('upserts values and supports cached null results', () => {
    cache = new Cache(':memory:')
    const now = Date.now()
    cache.set('esi:id', 'missing pilot', null, 10_000, now)
    expect(cache.get<null>('esi:id', 'missing pilot', now + 1)).toMatchObject({ value: null })

    cache.set('esi:id', 'missing pilot', { id: 99 }, 20_000, now + 10)
    expect(cache.get<{ id: number }>('esi:id', 'missing pilot', now + 11)?.value)
      .toEqual({ id: 99 })
    expect(cache.count()).toBe(1)
  })

  it('clears all entries and closes idempotently', () => {
    cache = new Cache(':memory:')
    cache.set('one', 'a', 1, 10_000)
    cache.set('two', 'b', 2, 10_000)
    cache.clear()

    expect(cache.stats()).toEqual({ entries: 0, databasePath: ':memory:' })
    cache.close()
    expect(() => cache?.close()).not.toThrow()
    cache = null
  })

  it('rejects invalid TTL values', () => {
    cache = new Cache(':memory:')
    expect(() => cache?.set('scope', 'key', 'value', 0)).toThrow(RangeError)
    expect(() => cache?.set('scope', 'key', 'value', Number.NaN)).toThrow(RangeError)
  })
})
