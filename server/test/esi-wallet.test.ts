import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EsiWalletJournalClient, parseWalletJournal } from '../src/esi-wallet.js'

describe('ESI wallet adapter', () => {
  it('preserves int64 IDs and decimal amounts from lossless JSON', () => {
    const [entry] = parseWalletJournal(`[
      {
        "id": 990000000000000001,
        "date": "2026-08-25T12:00:00Z",
        "ref_type": "player_donation",
        "description": "Player donation",
        "reason": "FS-ABCDEFGH",
        "amount": 100000000.47,
        "first_party_id": 90000001,
        "second_party_id": 90000099
      }
    ]`)
    assert.equal(entry?.journalId, '990000000000000001')
    assert.equal(entry?.amountMinor, 10_000_000_047n)
    assert.equal(entry?.firstPartyId, '90000001')
  })

  it('retries Retry-After, sends cache validators, and reads all pages', async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const responses = [
      new Response('busy', { status: 503, headers: { 'Retry-After': '2' } }),
      new Response(walletJson('990000000000000001'), {
        status: 200,
        headers: {
          ETag: '"wallet-v2"',
          'Last-Modified': 'Tue, 25 Aug 2026 12:00:00 GMT',
          'Cache-Control': 'public, max-age=60',
          'X-Pages': '2'
        }
      }),
      new Response(walletJson('990000000000000002'), { status: 200 })
    ]
    const delays: number[] = []
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) })
      const response = responses.shift()
      if (!response) throw new Error('Unexpected fetch')
      return response
    }) as typeof fetch
    const now = 1_777_118_400_000
    const client = new EsiWalletJournalClient({
      userAgent: 'Fly-Safe/Test test@example.invalid',
      fetch: fetchMock,
      now: () => now,
      sleep: async (milliseconds) => { delays.push(milliseconds) },
      random: () => 0
    })

    const result = await client.fetchJournal('90000099', 'access-token-with-enough-length', {
      etag: '"wallet-v1"',
      lastModified: 'Tue, 25 Aug 2026 11:00:00 GMT'
    })
    assert.deepEqual(delays, [2_000])
    assert.equal(calls.length, 3)
    assert.equal(calls[0]?.headers.get('if-none-match'), '"wallet-v1"')
    assert.equal(calls[0]?.headers.get('x-compatibility-date'), '2020-01-01')
    assert.match(calls[2]?.url ?? '', /page=2/u)
    assert.equal(calls[2]?.headers.get('if-none-match'), null)
    assert.equal(result.entries.length, 2)
    assert.equal(result.etag, '"wallet-v2"')
    assert.equal(result.nextPollAt, now + 60_000)
  })

  it('honors 304 and Expires without reparsing a body', async () => {
    const now = Date.parse('2026-08-25T12:00:00Z')
    const fetchMock = (async () => new Response(null, {
      status: 304,
      headers: { Expires: 'Tue, 25 Aug 2026 12:02:00 GMT' }
    })) as typeof fetch
    const client = new EsiWalletJournalClient({
      userAgent: 'Fly-Safe/Test test@example.invalid',
      fetch: fetchMock,
      now: () => now
    })
    const result = await client.fetchJournal('90000099', 'access-token-with-enough-length', {
      etag: '"same"',
      lastModified: null
    })
    assert.equal(result.notModified, true)
    assert.deepEqual(result.entries, [])
    assert.equal(result.etag, '"same"')
    assert.equal(result.nextPollAt, now + 120_000)
  })
})

function walletJson(id: string): string {
  return `[{
    "id": ${id},
    "date": "2026-08-25T12:00:00Z",
    "ref_type": "player_donation",
    "description": "Player donation",
    "reason": "FS-ABCDEFGH",
    "amount": 100000000,
    "first_party_id": 90000001,
    "second_party_id": 90000099
  }]`
}
