import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMBAT_RELAY_CONFIG_FILENAME,
  getCompiledCombatRelayUrl,
  resolveCombatRelayUrl,
  validateCombatRelayUrl
} from '../src/main/combat-relay-config'

const temporaryDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'fly-safe-combat-relay-'))
  temporaryDirectories.push(path)
  return path
}

function writeConfig(directory: string, baseUrl: string): void {
  writeFileSync(join(directory, COMBAT_RELAY_CONFIG_FILENAME), JSON.stringify({
    version: 1,
    baseUrl
  }))
}

describe('combat relay configuration', () => {
  it('keeps a compiled endpoint authoritative', () => {
    const directory = temporaryDirectory()
    writeFileSync(join(directory, COMBAT_RELAY_CONFIG_FILENAME), '{broken')

    expect(resolveCombatRelayUrl({
      userDataDirectory: directory,
      compiledUrl: 'https://combat.fly-safe.example/backend/',
      environment: { FLY_SAFE_COMBAT_RELAY_URL: 'http://public.example' },
      fallbackUrl: 'https://billing.fly-safe.example'
    })).toBe('https://combat.fly-safe.example/backend')
  })

  it('uses environment, user config, resources config, then caller fallback', () => {
    const directory = temporaryDirectory()
    const resources = join(directory, 'resources')
    mkdirSync(resources)
    writeConfig(directory, 'https://user-relay.fly-safe.example/')
    writeConfig(resources, 'https://packaged-relay.fly-safe.example/')

    expect(resolveCombatRelayUrl({
      userDataDirectory: directory,
      resourcesDirectory: resources,
      compiledUrl: '',
      environment: { FLY_SAFE_COMBAT_RELAY_URL: 'https://env-relay.fly-safe.example/' },
      fallbackUrl: 'https://billing.fly-safe.example'
    })).toBe('https://env-relay.fly-safe.example')

    expect(resolveCombatRelayUrl({
      userDataDirectory: directory,
      resourcesDirectory: resources,
      compiledUrl: '',
      environment: {},
      fallbackUrl: 'https://billing.fly-safe.example'
    })).toBe('https://user-relay.fly-safe.example')

    expect(resolveCombatRelayUrl({
      userDataDirectory: join(directory, 'missing-user-data'),
      resourcesDirectory: resources,
      compiledUrl: '',
      environment: {},
      fallbackUrl: 'https://billing.fly-safe.example'
    })).toBe('https://packaged-relay.fly-safe.example')

    expect(resolveCombatRelayUrl({
      userDataDirectory: join(directory, 'missing-user-data'),
      compiledUrl: '',
      environment: {},
      fallbackUrl: 'https://billing.fly-safe.example/'
    })).toBe('https://billing.fly-safe.example')
  })

  it('returns empty when neither a dedicated endpoint nor fallback is available', () => {
    const directory = temporaryDirectory()
    expect(resolveCombatRelayUrl({
      userDataDirectory: directory,
      compiledUrl: '',
      environment: {}
    })).toBe('')
  })

  it('reads the build-time constant safely when it is not defined', () => {
    expect(getCompiledCombatRelayUrl()).toBe('')
  })

  it('permits HTTP only for loopback addresses', () => {
    expect(validateCombatRelayUrl('http://localhost:8787/')).toBe('http://localhost:8787')
    expect(validateCombatRelayUrl('http://127.42.0.9:8787/')).toBe('http://127.42.0.9:8787')
    expect(validateCombatRelayUrl('http://[::1]:8787/')).toBe('http://[::1]:8787')
    expect(() => validateCombatRelayUrl('http://relay.example')).toThrow(/HTTPS/u)
    expect(() => validateCombatRelayUrl('ftp://localhost/relay')).toThrow(/HTTPS/u)
  })

  it('rejects credentials, queries, and fragments, including empty ones', () => {
    expect(() => validateCombatRelayUrl('https://user:pass@relay.example')).toThrow(
      /credentials/u
    )
    expect(() => validateCombatRelayUrl('https://relay.example?token=secret')).toThrow(/query/u)
    expect(() => validateCombatRelayUrl('https://relay.example?')).toThrow(/query/u)
    expect(() => validateCombatRelayUrl('https://relay.example#')).toThrow(/fragment/u)
  })

  it('requires the exact version-1 config schema', () => {
    const directory = temporaryDirectory()
    writeFileSync(join(directory, COMBAT_RELAY_CONFIG_FILENAME), JSON.stringify({
      version: 2,
      baseUrl: 'https://relay.example'
    }))
    expect(() => resolveCombatRelayUrl({
      userDataDirectory: directory,
      compiledUrl: '',
      environment: {}
    })).toThrow(/schema/u)

    writeFileSync(join(directory, COMBAT_RELAY_CONFIG_FILENAME), JSON.stringify({
      version: 1,
      baseUrl: 'https://relay.example',
      redirect: 'https://evil.example'
    }))
    expect(() => resolveCombatRelayUrl({
      userDataDirectory: directory,
      compiledUrl: '',
      environment: {}
    })).toThrow(/unknown fields/u)
  })

  it('rejects symlinked and oversized config files', () => {
    const directory = temporaryDirectory()
    const targetPath = join(directory, 'real-config.json')
    const configPath = join(directory, COMBAT_RELAY_CONFIG_FILENAME)
    writeFileSync(targetPath, JSON.stringify({
      version: 1,
      baseUrl: 'https://relay.example'
    }))
    symlinkSync(targetPath, configPath)

    expect(() => resolveCombatRelayUrl({
      userDataDirectory: directory,
      compiledUrl: '',
      environment: {}
    })).toThrow(/regular file/u)

    const secondDirectory = temporaryDirectory()
    writeFileSync(join(secondDirectory, COMBAT_RELAY_CONFIG_FILENAME), 'x'.repeat(4_097))
    expect(() => resolveCombatRelayUrl({
      userDataDirectory: secondDirectory,
      compiledUrl: '',
      environment: {}
    })).toThrow(/4096 bytes/u)
  })

  it('does not hide an invalid configured URL behind the fallback', () => {
    const directory = temporaryDirectory()
    writeConfig(directory, 'http://relay.example')
    expect(() => resolveCombatRelayUrl({
      userDataDirectory: directory,
      compiledUrl: '',
      environment: {},
      fallbackUrl: 'https://billing.fly-safe.example'
    })).toThrow(/HTTPS/u)
  })
})
