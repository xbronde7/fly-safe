import { expectPrivatePathMode } from './file-permissions'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyLicenseToken } from '../src/main/license-service'

const run = promisify(execFile)
const temporaryDirectories: string[] = []
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/license-admin.mjs', import.meta.url))

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true
  })))
})

describe('license admin CLI', () => {
  it('generates an external Ed25519 authority and issues a verifier-compatible key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eve-license-admin-'))
    temporaryDirectories.push(directory)
    const privateKeyPath = join(directory, 'authority', 'private.pem')
    const publicKeyPath = join(directory, 'authority', 'public.pem')
    const licensePath = join(directory, 'issued', 'test.license')
    const deviceCode = 'ELI-ABCD-EFGH-JKLM-NPQR-STUV'

    await run(process.execPath, [
      SCRIPT_PATH,
      'init',
      '--private-key', privateKeyPath,
      '--public-key', publicKeyPath
    ])
    await run(process.execPath, [
      SCRIPT_PATH,
      'issue',
      '--private-key', privateKeyPath,
      '--device-code', `Test Pilot > ${deviceCode}`,
      '--customer', 'Test Customer',
      '--license-id', 'TEST-CLI-001',
      '--lifetime',
      '--output', licensePath
    ])

    const token = (await readFile(licensePath, 'utf8')).trim()
    const publicKey = await readFile(publicKeyPath, 'utf8')
    expect(verifyLicenseToken(token, { publicKey, deviceCode }).license).toMatchObject({
      licenseId: 'TEST-CLI-001',
      customer: 'Test Customer',
      expiresAt: null
    })
    await expectPrivatePathMode(privateKeyPath, 0o600)
    expect(token).not.toContain('Test Customer')
  })

  it('rejects input containing multiple different device codes', async () => {
    const first = 'ELI-ABCD-EFGH-JKLM-NPQR-STUV'
    const second = 'ELI-2345-67AB-CDEF-GHJK-LMNP'

    await expect(run(process.execPath, [
      SCRIPT_PATH,
      'issue',
      '--device-code', `${first} > ${second}`,
      '--customer', 'Test Customer',
      '--lifetime'
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('Найдено несколько разных кодов устройства')
    })
  })
})
