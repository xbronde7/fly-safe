import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deriveLicenseDeviceCode,
  parseMacPlatformUuid,
  parseWindowsMachineGuid,
  resolveLicenseDeviceCode
} from '../src/main/license-device'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true
  })))
})

describe('license device code', () => {
  it('parses and normalizes the macOS platform UUID', () => {
    expect(parseMacPlatformUuid(`    "IOPlatformUUID" = "aabbccdd-1111-2222-3333-abcdef123456"`))
      .toBe('AABBCCDD-1111-2222-3333-ABCDEF123456')
  })

  it('parses and normalizes the Windows MachineGuid registry value', () => {
    expect(parseWindowsMachineGuid([
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography',
      '    MachineGuid    REG_SZ    {aabbccdd-1111-2222-3333-abcdef123456}',
      ''
    ].join('\r\n'))).toBe('AABBCCDD-1111-2222-3333-ABCDEF123456')
  })

  it('rejects malformed Windows MachineGuid registry output', () => {
    expect(() => parseWindowsMachineGuid([
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography',
      '    MachineGuid    REG_DWORD    0x1234'
    ].join('\r\n'))).toThrow('MachineGuid недоступен')
  })

  it('derives a stable public code without exposing the source identifier', () => {
    const source = 'mac:AABBCCDD-1111-2222-3333-ABCDEF123456'
    const first = deriveLicenseDeviceCode(source)

    expect(first).toBe(deriveLicenseDeviceCode(source))
    expect(first).toMatch(/^ELI-(?:[A-Z2-7]{4}-){4}[A-Z2-7]{4}$/)
    expect(first).not.toContain('AABBCCDD')
  })

  it('uses the hardware-derived code when macOS exposes a platform UUID', async () => {
    const directory = await createTemporaryDirectory()
    const code = await resolveLicenseDeviceCode({
      fallbackSecretPath: join(directory, 'fallback'),
      platform: 'darwin',
      readPlatformUuid: async () => 'AABBCCDD-1111-2222-3333-ABCDEF123456'
    })

    expect(code).toBe(deriveLicenseDeviceCode('mac:AABBCCDD-1111-2222-3333-ABCDEF123456'))
  })

  it('uses the machine-derived code when Windows exposes MachineGuid', async () => {
    const directory = await createTemporaryDirectory()
    const code = await resolveLicenseDeviceCode({
      fallbackSecretPath: join(directory, 'fallback'),
      platform: 'win32',
      readWindowsMachineGuid: async () => 'aabbccdd-1111-2222-3333-abcdef123456'
    })

    expect(code).toBe(deriveLicenseDeviceCode('windows:AABBCCDD-1111-2222-3333-ABCDEF123456'))
  })

  it('creates and reuses a private fallback secret when Windows registry lookup fails', async () => {
    const directory = await createTemporaryDirectory()
    const fallbackSecretPath = join(directory, 'license', 'device-secret')
    const options = {
      fallbackSecretPath,
      platform: 'win32' as const,
      readWindowsMachineGuid: async (): Promise<string> => {
        throw new Error('reg.exe unavailable')
      }
    }

    const first = await resolveLicenseDeviceCode(options)
    const second = await resolveLicenseDeviceCode(options)
    const stored = (await readFile(fallbackSecretPath, 'utf8')).trim()

    expect(first).toBe(second)
    expect(first).toMatch(/^ELI-(?:[A-Z2-7]{4}-){4}[A-Z2-7]{4}$/)
    expect(stored).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
    expect(first).not.toContain(stored)
  })

  it('creates and reuses a private fallback secret when hardware lookup fails', async () => {
    const directory = await createTemporaryDirectory()
    const fallbackSecretPath = join(directory, 'license', 'device-secret')
    const options = {
      fallbackSecretPath,
      platform: 'darwin' as const,
      readPlatformUuid: async (): Promise<string> => { throw new Error('ioreg unavailable') }
    }

    const first = await resolveLicenseDeviceCode(options)
    const second = await resolveLicenseDeviceCode(options)
    const stored = (await readFile(fallbackSecretPath, 'utf8')).trim()

    expect(first).toBe(second)
    expect(first).toMatch(/^ELI-(?:[A-Z2-7]{4}-){4}[A-Z2-7]{4}$/)
    expect(stored).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
    expect(first).not.toContain(stored)
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'eve-license-device-'))
  temporaryDirectories.push(directory)
  return directory
}
