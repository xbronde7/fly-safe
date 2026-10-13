import { afterEach, describe, expect, it, vi } from 'vitest'
import { CACHE_SCOPES, CACHE_TTL, Cache } from '../src/main/cache'
import {
  ZKILL_REQUEST_START_INTERVAL_MS,
  ZkillClient,
  type ZkillClock
} from '../src/main/zkill-client'
import { normalizeZkillStats } from '../src/shared/threat-score'

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function virtualClock(start = 0): {
  clock: ZkillClock
  now: () => number
  sleeps: number[]
} {
  let now = start
  const sleeps: number[] = []

  return {
    clock: {
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
        now += milliseconds
      }
    },
    now: () => now,
    sleeps
  }
}

function controlledClock(start = 0): {
  clock: ZkillClock
  now: () => number
  sleeps: Array<{ milliseconds: number; wakeAt: number }>
  releaseAll: () => void
} {
  let now = start
  const pending: Array<{ wakeAt: number; resolve: () => void }> = []
  const sleeps: Array<{ milliseconds: number; wakeAt: number }> = []

  return {
    clock: {
      now: () => now,
      sleep: (milliseconds) => new Promise<void>((resolve) => {
        const wakeAt = now + milliseconds
        sleeps.push({ milliseconds, wakeAt })
        pending.push({ wakeAt, resolve })
      })
    },
    now: () => now,
    sleeps,
    releaseAll: () => {
      const queued = pending.splice(0)
      if (queued.length === 0) return
      now = Math.max(now, ...queued.map(({ wakeAt }) => wakeAt))
      for (const { resolve } of queued) resolve()
    }
  }
}

async function flushMicrotasks(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

describe('ZkillClient request pacing', () => {
  let cache: Cache | null = null

  afterEach(() => {
    cache?.close()
    cache = null
  })

  it('spaces concurrent stats, character history, and system history request starts', async () => {
    cache = new Cache(':memory:')
    const time = virtualClock()
    const starts: Array<{ at: number; url: string }> = []
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      starts.push({ at: time.now(), url })
      return url.includes('/stats/') ? jsonResponse({ shipsDestroyed: 1 }) : jsonResponse([])
    })
    const client = new ZkillClient(cache, {
      baseUrl: 'https://zkill.test',
      fetch: fetchMock,
      maxAttempts: 1,
      clock: time.clock
    })

    await Promise.all([
      client.getCharacterStats(10, true),
      client.getCharacterHistory(20, 'kills', true),
      client.getSystemHistory(30, true)
    ])

    expect(starts.map(({ at }) => at)).toEqual([
      0,
      ZKILL_REQUEST_START_INTERVAL_MS,
      ZKILL_REQUEST_START_INTERVAL_MS * 2
    ])
    expect(starts.map(({ url }) => url)).toEqual([
      'https://zkill.test/api/stats/characterID/10/kills/',
      'https://zkill.test/api/kills/characterID/20/page/1/',
      'https://zkill.test/api/systemID/30/pastSeconds/86400/page/1/'
    ])
  })

  it('paces a retry even when Retry-After allows an immediate retry', async () => {
    cache = new Cache(':memory:')
    const time = virtualClock()
    const starts: number[] = []
    const fetchMock = vi.fn<typeof fetch>(async () => {
      starts.push(time.now())
      return starts.length === 1
        ? jsonResponse({ error: 'slow down' }, 429, { 'Retry-After': '0' })
        : jsonResponse([])
    })
    const client = new ZkillClient(cache, {
      fetch: fetchMock,
      maxAttempts: 2,
      clock: time.clock
    })

    await expect(client.getSystemHistory(30, true)).resolves.toMatchObject({ cached: false })
    expect(starts).toEqual([0, ZKILL_REQUEST_START_INTERVAL_MS])
    expect(time.sleeps).toEqual([0, ZKILL_REQUEST_START_INTERVAL_MS])
  })

  it('retries after the full delta-seconds Retry-After value', async () => {
    cache = new Cache(':memory:')
    const time = virtualClock()
    const starts: number[] = []
    const fetchMock = vi.fn<typeof fetch>(async () => {
      starts.push(time.now())
      return starts.length === 1
        ? jsonResponse({ error: 'slow down' }, 429, { 'Retry-After': '120' })
        : jsonResponse([])
    })
    const client = new ZkillClient(cache, {
      fetch: fetchMock,
      maxAttempts: 2,
      requestIntervalMs: 0,
      clock: time.clock
    })

    await expect(client.getSystemHistory(30, true)).resolves.toMatchObject({ cached: false })
    expect(starts).toEqual([0, 120_000])
    expect(time.sleeps).toEqual([120_000])
  })

  it('delays queued and forced network reads while serving fresh cache immediately', async () => {
    cache = new Cache(':memory:')
    const cachedStats = normalizeZkillStats({ shipsDestroyed: 7 })
    cache.set(CACHE_SCOPES.zkillStats, '99', cachedStats, CACHE_TTL.zkillStats)
    const time = controlledClock()
    const starts: Array<{ at: number; url: string }> = []
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      starts.push({ at: time.now(), url })
      return starts.length === 1
        ? jsonResponse({ error: 'slow down' }, 429, { 'Retry-After': '120' })
        : jsonResponse([])
    })
    const client = new ZkillClient(cache, {
      baseUrl: 'https://zkill.test',
      fetch: fetchMock,
      maxAttempts: 1,
      requestIntervalMs: ZKILL_REQUEST_START_INTERVAL_MS,
      clock: time.clock
    })

    const limited = client.getCharacterHistory(10, 'kills', true)
      .then(() => null, (error: unknown) => error)
    const queuedForced = client.getSystemHistory(30, true)
    await flushMicrotasks()

    expect(await limited).toBeInstanceOf(Error)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(time.sleeps.map(({ wakeAt }) => wakeAt)).toContain(
      ZKILL_REQUEST_START_INTERVAL_MS
    )

    const sleepsBeforeCacheRead = time.sleeps.length
    await expect(client.getCharacterStats(99)).resolves.toMatchObject({
      stats: { shipsDestroyed: 7 },
      cached: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(time.sleeps).toHaveLength(sleepsBeforeCacheRead)

    time.releaseAll()
    await flushMicrotasks()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(time.sleeps.map(({ wakeAt }) => wakeAt)).toContain(120_000)

    time.releaseAll()
    await flushMicrotasks()

    await expect(queuedForced).resolves.toMatchObject({ cached: false })
    expect(starts.map(({ at }) => at)).toEqual([0, 120_000])
  })

  it('honors a long HTTP-date Retry-After without the former 30 second clamp', async () => {
    cache = new Cache(':memory:')
    const startedAt = Date.parse('2026-08-25T12:00:00Z')
    const time = virtualClock(startedAt)
    const retryAt = new Date(startedAt + 5 * 60_000).toUTCString()
    const starts: number[] = []
    const fetchMock = vi.fn<typeof fetch>(async () => {
      starts.push(time.now())
      return starts.length === 1
        ? jsonResponse({ error: 'slow down' }, 429, { 'Retry-After': retryAt })
        : jsonResponse([])
    })
    const client = new ZkillClient(cache, {
      fetch: fetchMock,
      maxAttempts: 1,
      requestIntervalMs: 0,
      clock: time.clock
    })

    await expect(client.getCharacterHistory(10, 'losses', true)).rejects.toThrow()
    await expect(client.getSystemHistory(30, true)).resolves.toMatchObject({ cached: false })

    expect(starts).toEqual([startedAt, startedAt + 5 * 60_000])
    expect(time.sleeps).toContain(5 * 60_000)
  })

  it('returns cache hits without entering the request-start gate', async () => {
    cache = new Cache(':memory:')
    const cachedStats = normalizeZkillStats({ shipsDestroyed: 7 })
    cache.set(CACHE_SCOPES.zkillStats, '10', cachedStats, CACHE_TTL.zkillStats)
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error('cache hit must not fetch')
    })
    const sleep = vi.fn(async () => {
      throw new Error('cache hit must not wait')
    })
    const client = new ZkillClient(cache, {
      fetch: fetchMock,
      clock: { now: () => 0, sleep }
    })

    await expect(client.getCharacterStats(10)).resolves.toMatchObject({
      stats: { shipsDestroyed: 7 },
      cached: true,
      error: null
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('releases a failed pacing turn so the next queued request can start', async () => {
    cache = new Cache(':memory:')
    let now = 0
    let failNextWait = true
    const starts: number[] = []
    const fetchMock = vi.fn<typeof fetch>(async () => {
      starts.push(now)
      return jsonResponse([])
    })
    const client = new ZkillClient(cache, {
      fetch: fetchMock,
      maxAttempts: 1,
      clock: {
        now: () => now,
        sleep: async (milliseconds) => {
          if (failNextWait) {
            failNextWait = false
            throw new Error('clock unavailable')
          }
          now += milliseconds
        }
      }
    })

    const results = await Promise.allSettled([
      client.getCharacterHistory(10, 'kills', true),
      client.getCharacterHistory(20, 'losses', true),
      client.getSystemHistory(30, true)
    ])

    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(starts).toEqual([0, ZKILL_REQUEST_START_INTERVAL_MS])
  })

  it('loads and caches each character-history page independently', async () => {
    cache = new Cache(':memory:')
    const requestedUrls: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      requestedUrls.push(url)
      return jsonResponse([{ killmail_id: url.includes('/page/2/') ? 2 : 1 }])
    })
    const client = new ZkillClient(cache, {
      baseUrl: 'https://zkill.test',
      fetch: fetchMock,
      maxAttempts: 1,
      requestIntervalMs: 0
    })

    await expect(client.getCharacterHistory(10, 'kills', false, 1)).resolves.toMatchObject({
      page: 1,
      cached: false,
      killmails: [{ killmail_id: 1 }]
    })
    await expect(client.getCharacterHistory(10, 'kills', false, 2)).resolves.toMatchObject({
      page: 2,
      cached: false,
      killmails: [{ killmail_id: 2 }]
    })
    await expect(client.getCharacterHistory(10, 'kills', false, 2)).resolves.toMatchObject({
      page: 2,
      cached: true
    })

    expect(requestedUrls).toEqual([
      'https://zkill.test/api/kills/characterID/10/page/1/',
      'https://zkill.test/api/kills/characterID/10/page/2/'
    ])
  })

  it('rejects an invalid character-history page before network access', async () => {
    cache = new Cache(':memory:')
    const fetchMock = vi.fn<typeof fetch>()
    const client = new ZkillClient(cache, { fetch: fetchMock })

    await expect(client.getCharacterHistory(10, 'kills', false, 0)).rejects.toThrow(
      'Invalid zKill history page'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
