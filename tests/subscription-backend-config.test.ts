import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveSubscriptionBackendUrl,
  SUBSCRIPTION_BACKEND_CONFIG_FILENAME,
  validateSubscriptionBackendUrl
} from '../src/main/subscription-backend-config'

const temporaryDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'fly-safe-backend-'))
  temporaryDirectories.push(path)
  return path
}

describe('subscription backend configuration', () => {
  it('keeps a compiled release endpoint authoritative', () => {
    const directory = temporaryDirectory()
    expect(resolveSubscriptionBackendUrl({
      userDataDirectory: directory,
      compiledUrl: 'https://billing.fly-safe.example/api/',
      environment: { FLY_SAFE_ENTITLEMENT_API_URL: 'https://evil.example' }
    })).toBe('https://billing.fly-safe.example/api')
  })

  it('supports a strict per-install config when the build has no embedded endpoint', () => {
    const directory = temporaryDirectory()
    writeFileSync(join(directory, SUBSCRIPTION_BACKEND_CONFIG_FILENAME), JSON.stringify({
      version: 1,
      baseUrl: 'https://subscriptions.fly-safe.example/v1-root/'
    }))
    expect(resolveSubscriptionBackendUrl({
      userDataDirectory: directory,
      compiledUrl: '',
      environment: {}
    })).toBe('https://subscriptions.fly-safe.example/v1-root')
  })

  it('also supports a packaged config and returns empty when none exists', () => {
    const directory = temporaryDirectory()
    const resources = join(directory, 'resources')
    mkdirSync(resources)
    writeFileSync(join(resources, SUBSCRIPTION_BACKEND_CONFIG_FILENAME), JSON.stringify({
      version: 1,
      baseUrl: 'https://api.fly-safe.example'
    }))
    expect(resolveSubscriptionBackendUrl({
      userDataDirectory: directory,
      resourcesDirectory: resources,
      compiledUrl: '',
      environment: {}
    })).toBe('https://api.fly-safe.example')
    expect(resolveSubscriptionBackendUrl({
      userDataDirectory: join(directory, 'empty'),
      compiledUrl: '',
      environment: {}
    })).toBe('')
  })

  it('permits HTTP only on loopback and rejects URL credential tricks', () => {
    expect(validateSubscriptionBackendUrl('http://127.0.0.2:8787')).toBe('http://127.0.0.2:8787')
    expect(validateSubscriptionBackendUrl('http://[::1]:8787/')).toBe('http://[::1]:8787')
    expect(() => validateSubscriptionBackendUrl('http://billing.example')).toThrow(/HTTPS/u)
    expect(() => validateSubscriptionBackendUrl('https://user:pass@billing.example')).toThrow(
      /credentials/u
    )
    expect(() => validateSubscriptionBackendUrl('https://billing.example?q=token')).toThrow(
      /query/u
    )
  })

  it('rejects unknown config fields instead of accepting ambiguous input', () => {
    const directory = temporaryDirectory()
    writeFileSync(join(directory, SUBSCRIPTION_BACKEND_CONFIG_FILENAME), JSON.stringify({
      version: 1,
      baseUrl: 'https://api.fly-safe.example',
      redirect: 'https://evil.example'
    }))
    expect(() => resolveSubscriptionBackendUrl({
      userDataDirectory: directory,
      compiledUrl: '',
      environment: {}
    })).toThrow(/unknown fields/u)
  })
})
