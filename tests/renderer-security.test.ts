import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  createRendererTrustPolicy,
  isTrustedIpcSender,
  isTrustedRendererUrl,
  type IpcSenderFacts
} from '../src/main/renderer-security'

describe('renderer trust policy', () => {
  it('allows only the exact bundled renderer document in production', () => {
    const path = resolve('/Applications/Fly Safe.app/Contents/Resources/app.asar/out/renderer/index.html')
    const policy = createRendererTrustPolicy(undefined, path)
    const entryUrl = pathToFileURL(path).href

    expect(policy).toEqual({ mode: 'production', entryUrl })
    expect(isTrustedRendererUrl(entryUrl, policy)).toBe(true)
    expect(isTrustedRendererUrl(`${entryUrl}#system`, policy)).toBe(true)
    expect(isTrustedRendererUrl(entryUrl.replace('index.html', 'other.html'), policy)).toBe(false)
    expect(isTrustedRendererUrl(`${entryUrl}.attacker`, policy)).toBe(false)
    expect(isTrustedRendererUrl('file:///tmp/index.html', policy)).toBe(false)
    expect(isTrustedRendererUrl('https://example.test/', policy)).toBe(false)
  })

  it('allows only the configured HTTP(S) origin in development', () => {
    const policy = createRendererTrustPolicy('http://localhost:5173/app/', '/unused')

    expect(isTrustedRendererUrl('http://localhost:5173/app/', policy)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173/another-route?x=1', policy)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5173.evil.test/app/', policy)).toBe(false)
    expect(isTrustedRendererUrl('http://localhost:5174/app/', policy)).toBe(false)
    expect(isTrustedRendererUrl('https://localhost:5173/app/', policy)).toBe(false)
    expect(isTrustedRendererUrl('not a URL', policy)).toBe(false)
  })

  it('rejects invalid or non-web development renderer URLs', () => {
    expect(() => createRendererTrustPolicy('not a URL', '/unused')).toThrow(TypeError)
    expect(() => createRendererTrustPolicy('file:///tmp/index.html', '/unused')).toThrow(TypeError)
  })
})

describe('IPC sender trust', () => {
  const policy = createRendererTrustPolicy(undefined, '/Applications/EVE.app/index.html')
  const trustedUrl = policy.entryUrl
  const trusted: IpcSenderFacts = {
    senderUrl: trustedUrl,
    frameUrl: trustedUrl,
    senderMatchesMainWindow: true,
    frameIsMainFrame: true,
    senderDestroyed: false,
    frameDestroyed: false
  }

  it('requires both sender and top-frame URLs to be trusted', () => {
    expect(isTrustedIpcSender(trusted, policy)).toBe(true)
    expect(
      isTrustedIpcSender({ ...trusted, frameUrl: 'file:///tmp/attacker.html' }, policy)
    ).toBe(false)
    expect(
      isTrustedIpcSender({ ...trusted, senderUrl: 'file:///tmp/attacker.html' }, policy)
    ).toBe(false)
  })

  it.each([
    ['other webContents', { senderMatchesMainWindow: false }],
    ['child frame', { frameIsMainFrame: false }],
    ['destroyed sender', { senderDestroyed: true }],
    ['destroyed frame', { frameDestroyed: true }]
  ])('rejects %s', (_label, change) => {
    expect(isTrustedIpcSender({ ...trusted, ...change }, policy)).toBe(false)
  })
})
