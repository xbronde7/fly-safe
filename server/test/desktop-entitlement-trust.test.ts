import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import {
  DESKTOP_ENTITLEMENT_KEY_ID,
  DESKTOP_ENTITLEMENT_PUBLIC_KEY_SPKI_SHA256,
  assertEntitlementSignerMatchesDesktopTrust,
  entitlementPublicKeySpkiSha256
} from '../src/desktop-entitlement-trust.js'

const execFileAsync = promisify(execFile)

describe('desktop entitlement signing trust', () => {
  it('accepts an Ed25519 signer only when both key ID and public fingerprint match', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const fingerprint = entitlementPublicKeySpkiSha256(publicKey)

    assert.doesNotThrow(() => assertEntitlementSignerMatchesDesktopTrust(
      { keyId: 'test-key-01', publicKey },
      { keyId: 'test-key-01', publicKeySpkiSha256: fingerprint }
    ))
  })

  it('rejects a wrong key ID before accepting otherwise matching public material', () => {
    const { publicKey } = generateKeyPairSync('ed25519')
    const fingerprint = entitlementPublicKeySpkiSha256(publicKey)

    assert.throws(
      () => assertEntitlementSignerMatchesDesktopTrust(
        { keyId: 'wrong-key-01', publicKey },
        { keyId: 'desktop-key-01', publicKeySpkiSha256: fingerprint }
      ),
      /does not match desktop trusted key ID/u
    )
  })

  it('rejects a different private key by comparing public fingerprints only', () => {
    const first = generateKeyPairSync('ed25519')
    const second = generateKeyPairSync('ed25519')
    const expected = entitlementPublicKeySpkiSha256(first.publicKey)
    const actual = entitlementPublicKeySpkiSha256(second.publicKey)

    assert.throws(
      () => assertEntitlementSignerMatchesDesktopTrust(
        { keyId: 'desktop-key-01', publicKey: second.publicKey },
        { keyId: 'desktop-key-01', publicKeySpkiSha256: expected }
      ),
      (error: unknown) => {
        assert(error instanceof Error)
        assert.match(error.message, new RegExp(`sha256:${actual}`, 'u'))
        assert.match(error.message, new RegExp(`sha256:${expected}`, 'u'))
        assert.doesNotMatch(error.message, /PRIVATE KEY/u)
        return true
      }
    )
  })

  it('stops the real server startup before SQLite or listen when the private key differs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fly-safe-entitlement-trust-'))
    const keyPath = join(directory, 'wrong-private.pem')
    const databasePath = join(directory, 'must-not-exist.sqlite')
    const { privateKey } = generateKeyPairSync('ed25519')
    await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

    try {
      await assert.rejects(
        execFileAsync(process.execPath, [resolve(process.cwd(), 'dist', 'src', 'index.js')], {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOST: '127.0.0.1',
            PORT: '65530',
            DATABASE_PATH: databasePath,
            EVE_CLIENT_ID: '722024be688548e4b022064636ecd652',
            CASHIER_CHARACTER_ID: '90000099',
            CASHIER_REFRESH_TOKEN: 'test-refresh-token',
            ENTITLEMENT_PRIVATE_KEY_PATH: keyPath,
            ENTITLEMENT_KEY_ID: DESKTOP_ENTITLEMENT_KEY_ID,
            ADMIN_TOKEN: 'test-admin-token-with-at-least-32-characters',
            ESI_USER_AGENT: 'Fly-Safe-Test/1.0 test@example.invalid'
          }
        }),
        (error: unknown) => {
          assert(error instanceof Error)
          const stderrValue = (error as Error & { stderr?: unknown }).stderr
          const stderr = typeof stderrValue === 'string' ? stderrValue : ''
          assert.match(stderr, /startup_failed/u)
          assert.match(stderr, /does not match desktop trusted fingerprint/u)
          assert.match(stderr, /entitlement server will not start/u)
          assert.doesNotMatch(stderr, /BEGIN PRIVATE KEY/u)
          return true
        }
      )
      await assert.rejects(stat(databasePath), { code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('stays synchronized with the public key and kid compiled into the desktop source', async () => {
    const desktopSource = await readFile(
      resolve(process.cwd(), '..', 'src', 'main', 'license-public-key.ts'),
      'utf8'
    )
    const keyId = /LICENSE_PUBLIC_KEY_ID\s*=\s*'([^']+)'/u.exec(desktopSource)?.[1]
    const publicKeyPem = /LICENSE_PUBLIC_KEY_PEM\s*=\s*`([\s\S]*?)`/u.exec(desktopSource)?.[1]
    assert.equal(keyId, DESKTOP_ENTITLEMENT_KEY_ID)
    assert.ok(publicKeyPem, 'desktop public key PEM not found')

    const spki = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
    const fingerprint = createHash('sha256').update(spki).digest('hex')
    assert.equal(fingerprint, DESKTOP_ENTITLEMENT_PUBLIC_KEY_SPKI_SHA256)
  })
})
