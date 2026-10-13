import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type RendererTrustPolicy =
  | {
      mode: 'development'
      /** Canonical URL passed to BrowserWindow.loadURL. */
      entryUrl: string
      /** The only origin allowed to host the development renderer. */
      origin: string
    }
  | {
      mode: 'production'
      /** Exact canonical URL of the bundled renderer index. */
      entryUrl: string
    }

export interface IpcSenderFacts {
  senderUrl: string | null
  frameUrl: string | null
  senderMatchesMainWindow: boolean
  frameIsMainFrame: boolean
  senderDestroyed: boolean
  frameDestroyed: boolean
}

/**
 * Builds one renderer trust boundary shared by navigation and IPC checks.
 * Development trusts only the configured HTTP(S) origin. Production trusts
 * one exact bundled file, with an optional fragment for in-document routing.
 */
export function createRendererTrustPolicy(
  configuredRendererUrl: string | undefined,
  bundledRendererPath: string
): RendererTrustPolicy {
  if (configuredRendererUrl) {
    const entry = parseUrl(configuredRendererUrl)
    if (!entry || (entry.protocol !== 'http:' && entry.protocol !== 'https:')) {
      throw new TypeError('ELECTRON_RENDERER_URL must be a valid HTTP(S) URL')
    }

    return {
      mode: 'development',
      entryUrl: entry.href,
      origin: entry.origin
    }
  }

  return {
    mode: 'production',
    entryUrl: pathToFileURL(resolve(bundledRendererPath)).href
  }
}

/** Returns true only when a navigation remains inside the configured renderer boundary. */
export function isTrustedRendererUrl(
  candidateUrl: string | null | undefined,
  policy: RendererTrustPolicy
): boolean {
  if (!candidateUrl) return false
  const candidate = parseUrl(candidateUrl)
  if (!candidate) return false

  if (policy.mode === 'development') {
    return (
      (candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
      candidate.origin === policy.origin
    )
  }

  // A fragment cannot select another local file and may be used by an in-page router.
  candidate.hash = ''
  const expected = new URL(policy.entryUrl)
  expected.hash = ''
  return candidate.href === expected.href
}

/**
 * IPC is accepted only from the live top frame of the one application window,
 * and both Electron's sender URL and frame URL must remain trusted.
 */
export function isTrustedIpcSender(
  facts: IpcSenderFacts,
  policy: RendererTrustPolicy
): boolean {
  return (
    facts.senderMatchesMainWindow &&
    facts.frameIsMainFrame &&
    !facts.senderDestroyed &&
    !facts.frameDestroyed &&
    isTrustedRendererUrl(facts.senderUrl, policy) &&
    isTrustedRendererUrl(facts.frameUrl, policy)
  )
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}
