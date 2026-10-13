import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EveAccountStatus } from '../src/shared/types'
import {
  CharacterGate,
  CharacterGateView,
  EVE_SSO_CALLBACK_URI
} from '../src/renderer/src/CharacterGate'

function accountStatus(connected: boolean, clientId: string | null = null): EveAccountStatus {
  return {
    configured: clientId !== null,
    connected,
    clientId,
    callbackUri: EVE_SSO_CALLBACK_URI,
    characterId: connected ? 21_122_560_144 : null,
    characterName: connected ? 'Serg Xbronde' : null,
    scopes: [],
    error: null
  }
}

const noOp = (): void => undefined
const noOpAsync = async (): Promise<void> => undefined

describe('CharacterGate', () => {
  it('starts in checking state and does not mount protected children', () => {
    const markup = renderToStaticMarkup(
      <CharacterGate
        getAccountStatus={async () => accountStatus(false)}
        restoreAccount={async () => accountStatus(false)}
        connectAccount={async () => accountStatus(true)}
        cancelAccountConnect={noOpAsync}
      >
        <div>PRIVATE APP</div>
      </CharacterGate>
    )

    expect(markup).toContain('Checking character')
    expect(markup).not.toContain('PRIVATE APP')
  })

  it('shows the embedded Fly Safe OAuth application while disconnected', () => {
    const markup = renderToStaticMarkup(
      <CharacterGateView
        account={accountStatus(false)}
        checking={false}
        connecting={false}
        cancelling={false}
        error={null}
        onConnect={noOp}
        onCancelConnect={noOp}
        onRetry={noOp}
      >
        <div>PRIVATE APP</div>
      </CharacterGateView>
    )

    expect(markup).toContain('Sign in with your character')
    expect(markup).toContain('Official Fly Safe application')
    expect(markup).not.toContain('Client ID')
    expect(markup).toContain(EVE_SSO_CALLBACK_URI)
    expect(markup).toContain('Sign in with EVE Online')
    expect(markup).not.toContain('PRIVATE APP')
  })

  it('renders only protected children after SSO reports a connected character', () => {
    const markup = renderToStaticMarkup(
      <CharacterGateView
        account={accountStatus(true, 'embedded-client')}
        checking={false}
        connecting={false}
        cancelling={false}
        error={null}
        onConnect={noOp}
        onCancelConnect={noOp}
        onRetry={noOp}
      >
        <div>PRIVATE APP</div>
      </CharacterGateView>
    )

    expect(markup).toContain('PRIVATE APP')
    expect(markup).not.toContain('character-gate')
    expect(markup).not.toContain('Client ID')
  })

  it('renders account errors without exposing protected children', () => {
    const markup = renderToStaticMarkup(
      <CharacterGateView
        account={accountStatus(false, 'embedded-client')}
        checking={false}
        connecting={false}
        cancelling={false}
        error="SSO callback недоступен"
        onConnect={noOp}
        onCancelConnect={noOp}
        onRetry={noOp}
      >
        <div>PRIVATE APP</div>
      </CharacterGateView>
    )

    expect(markup).toContain('SSO callback недоступен')
    expect(markup).not.toContain('PRIVATE APP')
  })

  it('shows session-only Keychain guidance and an escape from a stalled browser', () => {
    const sessionOnly = { ...accountStatus(false, 'embedded-client'), sessionOnly: true }
    const markup = renderToStaticMarkup(
      <CharacterGateView
        account={sessionOnly}
        checking={false}
        connecting={true}
        cancelling={false}
        error={null}
        onConnect={noOp}
        onCancelConnect={noOp}
        onRetry={noOp}
      >
        <div>PRIVATE APP</div>
      </CharacterGateView>
    )

    expect(markup).toContain('no Keychain prompt')
    expect(markup).toContain('Cancel sign-in')
    expect(markup).not.toContain('PRIVATE APP')
  })
})
