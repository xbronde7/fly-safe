import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import { SignJWT, createLocalJWKSet, exportJWK } from 'jose'
import { EveJwtVerifier, FLY_SAFE_EVE_CLIENT_ID } from '../src/auth.js'
import { ServiceError } from '../src/domain.js'

describe('EVE bearer verification', () => {
  it('verifies signature and both required audiences, then derives principal from sub', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = { ...(await exportJWK(publicKey)), kid: 'eve-test', alg: 'RS256', use: 'sig' }
    const now = 1_700_000_000
    const verifier = new EveJwtVerifier({
      keyResolver: createLocalJWKSet({ keys: [jwk] }),
      now: () => now * 1_000
    })
    const token = await new SignJWT({ name: 'Test Pilot', scp: [] })
      .setProtectedHeader({ alg: 'RS256', kid: 'eve-test' })
      .setIssuer('https://login.eveonline.com')
      .setAudience(['EVE Online', FLY_SAFE_EVE_CLIENT_ID])
      .setSubject('CHARACTER:EVE:90000001')
      .setIssuedAt(now)
      .setExpirationTime(now + 1_200)
      .sign(privateKey)

    assert.deepEqual(await verifier.verify(token), {
      characterId: '90000001',
      characterName: 'Test Pilot',
      scopes: []
    })
  })

  it('rejects a valid EVE token issued for another client', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = { ...(await exportJWK(publicKey)), kid: 'eve-test', alg: 'RS256', use: 'sig' }
    const now = 1_700_000_000
    const verifier = new EveJwtVerifier({
      keyResolver: createLocalJWKSet({ keys: [jwk] }),
      now: () => now * 1_000
    })
    const token = await new SignJWT({ name: 'Test Pilot', scp: [] })
      .setProtectedHeader({ alg: 'RS256', kid: 'eve-test' })
      .setIssuer('https://login.eveonline.com')
      .setAudience(['EVE Online', 'some-other-client'])
      .setSubject('CHARACTER:EVE:90000001')
      .setExpirationTime(now + 1_200)
      .sign(privateKey)

    await assert.rejects(
      verifier.verify(token),
      (error) => error instanceof ServiceError && error.code === 'unauthorized'
    )
  })
})
