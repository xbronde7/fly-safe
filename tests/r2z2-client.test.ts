import { describe, expect, it, vi } from 'vitest'
import {
  R2z2Client,
  R2z2Error,
  R2Z2_RATE_POLICY
} from '../src/main/r2z2-client'

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

describe('R2z2Client', () => {
  it('requires a nonblank User-Agent', () => {
    expect(() => new R2z2Client({ userAgent: '   ' })).toThrow(/User-Agent/)
  })

  it('discovers the starting sequence and reads files strictly in sequence', async () => {
    let now = Date.parse('2026-08-21T12:00:00Z')
    const sleeps: number[] = []
    const urls: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input)
      urls.push(url)
      expect(new Headers(init?.headers).get('user-agent')).toBe('test@example.invalid')
      if (url.endsWith('/sequence.json')) return jsonResponse({ sequence: 100 })
      if (url.endsWith('/100.json')) return jsonResponse({ sequence_id: 100 })
      if (url.endsWith('/101.json')) return jsonResponse({ sequence_id: 101 })
      if (url.endsWith('/102.json')) return jsonResponse({ message: 'not ready' }, 404)
      return jsonResponse({}, 500)
    })
    const client = new R2z2Client({
      baseUrl: 'https://r2z2.test/ephemeral/',
      userAgent: 'test@example.invalid',
      fetch: fetchMock,
      clock: {
        now: () => now,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
          now += milliseconds
        }
      }
    })

    const discovery = await client.discoverSequence()
    const batch = await client.getBatch(discovery.sequenceId, 5)

    expect(discovery.sequenceId).toBe(100)
    expect(urls).toEqual([
      'https://r2z2.test/ephemeral/sequence.json',
      'https://r2z2.test/ephemeral/100.json',
      'https://r2z2.test/ephemeral/101.json',
      'https://r2z2.test/ephemeral/102.json'
    ])
    expect(sleeps).toEqual([100, 100])
    expect(batch).toMatchObject({
      fromSequenceId: 100,
      nextSequenceId: 102,
      stopReason: 'not-found',
      recommendedPollAfterMs: 6_000
    })
    expect(batch.records.map((record) => record.sequenceId)).toEqual([100, 101])
  })

  it('returns the minimum six-second 404 recommendation without sleeping for it', async () => {
    const sleep = vi.fn(async () => undefined)
    const client = new R2z2Client({
      fetch: async () => jsonResponse({}, 404, { 'Retry-After': '2' }),
      clock: { now: () => 1_777_000_000_000, sleep }
    })

    const result = await client.getSequence(500)

    expect(result).toMatchObject({
      kind: 'not-found',
      sequenceId: 500,
      recommendedPollAfterMs: R2Z2_RATE_POLICY.minimumNotFoundPollMs
    })
    expect(result.request.retryAfterMs).toBe(2_000)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('exposes response rate-limit and Retry-After metadata on throttling', async () => {
    const now = Date.parse('2026-08-21T12:00:00Z')
    const client = new R2z2Client({
      fetch: async () => jsonResponse(
        { error: 'slow down' },
        429,
        {
          'Retry-After': '8',
          'X-RateLimit-Limit': '15',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.floor((now + 8_000) / 1_000))
        }
      ),
      clock: { now: () => now, sleep: async () => undefined }
    })

    const error = await client.getSequence(600).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(R2z2Error)
    expect(error).toMatchObject({
      status: 429,
      sequenceId: 600,
      recommendedRetryAfterMs: 8_000,
      request: {
        retryAfterMs: 8_000,
        rateLimit: {
          documentedLimitPerSecond: 15,
          responseLimit: 15,
          responseRemaining: 0,
          responseResetAt: new Date(now + 8_000).toISOString()
        }
      }
    })
  })
})
