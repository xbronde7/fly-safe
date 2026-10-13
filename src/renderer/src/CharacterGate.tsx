import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { EveAccountStatus } from '../../shared/types'
import { FLY_SAFE_EVE_CALLBACK_URI } from '../../shared/eve-application'
import './character-gate.css'

export const EVE_SSO_CALLBACK_URI = FLY_SAFE_EVE_CALLBACK_URI
const ACCOUNT_RECHECK_INTERVAL_MS = 15_000

export interface CharacterGateProps {
  getAccountStatus: () => Promise<EveAccountStatus>
  restoreAccount: () => Promise<EveAccountStatus>
  connectAccount: () => Promise<EveAccountStatus>
  cancelAccountConnect: () => Promise<void>
  children: ReactNode
}

interface CharacterGateViewProps {
  account: EveAccountStatus | null
  checking: boolean
  connecting: boolean
  cancelling: boolean
  error: string | null
  onConnect: (event: FormEvent<HTMLFormElement>) => void
  onCancelConnect: () => void
  onRetry: () => void
  children: ReactNode
}

export function CharacterGate({
  getAccountStatus,
  restoreAccount,
  connectAccount,
  cancelAccountConnect,
  children
}: CharacterGateProps): ReactNode {
  const [account, setAccount] = useState<EveAccountStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const refreshInFlightRef = useRef(false)

  const refreshAccount = useCallback(async (): Promise<void> => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true

    try {
      const nextAccount = await getAccountStatus()
      if (!mountedRef.current) return
      setAccount(nextAccount)
      setError(nextAccount.error)
    } catch (caught) {
      if (!mountedRef.current) return
      setAccount(null)
      setError(`Could not check sign-in: ${readCharacterGateError(caught)}`)
    } finally {
      refreshInFlightRef.current = false
      if (mountedRef.current) setChecking(false)
    }
  }, [getAccountStatus])

  useEffect(() => {
    mountedRef.current = true
    void refreshAccount()

    const refreshOnFocus = (): void => { void refreshAccount() }
    window.addEventListener('focus', refreshOnFocus)
    const interval = window.setInterval(() => void refreshAccount(), ACCOUNT_RECHECK_INTERVAL_MS)

    return () => {
      mountedRef.current = false
      window.removeEventListener('focus', refreshOnFocus)
      window.clearInterval(interval)
    }
  }, [refreshAccount])

  async function handleConnect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (connecting) return

    setConnecting(true)
    setError(null)
    try {
      const nextAccount = await connectAccount()
      if (!mountedRef.current) return
      setAccount(nextAccount)
      setError(
        nextAccount.connected
          ? null
          : nextAccount.error || 'Sign-in did not finish. Approve access in your browser and try again.'
      )
    } catch (caught) {
      if (mountedRef.current) {
        setError(`Sign-in did not finish: ${readCharacterGateError(caught)}`)
      }
    } finally {
      if (mountedRef.current) setConnecting(false)
    }
  }

  async function handleCancelConnect(): Promise<void> {
    if (!connecting || cancelling) return
    setCancelling(true)
    try {
      await cancelAccountConnect()
      if (mountedRef.current) setError('Sign-in cancelled. You can try again now.')
    } catch (caught) {
      if (mountedRef.current) {
        setError(`Could not cancel sign-in: ${readCharacterGateError(caught)}`)
      }
    } finally {
      if (mountedRef.current) {
        setConnecting(false)
        setCancelling(false)
      }
    }
  }

  return (
    <CharacterGateView
      account={account}
      checking={checking}
      connecting={connecting}
      cancelling={cancelling}
      error={error}
      onConnect={(event) => void handleConnect(event)}
      onCancelConnect={() => void handleCancelConnect()}
      onRetry={() => {
        setChecking(true)
        setError(null)
        void restoreAccount().then((nextAccount) => {
          if (!mountedRef.current) return
          setAccount(nextAccount)
          setError(nextAccount.error)
        }).catch((caught) => {
          if (mountedRef.current) {
            setError(`Could not restore sign-in: ${readCharacterGateError(caught)}`)
          }
        }).finally(() => {
          if (mountedRef.current) setChecking(false)
        })
      }}
    >
      {children}
    </CharacterGateView>
  )
}

export function CharacterGateView({
  account,
  checking,
  connecting,
  cancelling,
  error,
  onConnect,
  onCancelConnect,
  onRetry,
  children
}: CharacterGateViewProps): ReactNode {
  if (account?.connected) return children

  return (
    <main className="character-gate" aria-labelledby="character-gate-title">
      <div className="character-gate__drag-strip" aria-hidden="true" />
      <div className="character-gate__scanline" aria-hidden="true" />
      <div className="character-gate__radar" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <section className="character-gate__card">
        <header className="character-gate__header">
          <div className="character-gate__portrait" aria-hidden="true">
            <PilotIcon />
            <i />
          </div>
          <div>
            <p className="character-gate__eyebrow">EVE SSO · REQUIRED SIGN-IN</p>
            <h1 id="character-gate-title">
              {checking ? 'Checking character…' : 'Sign in with your character'}
            </h1>
          </div>
        </header>

        {checking ? (
          <div className="character-gate__checking" role="status" aria-live="polite">
            <span className="character-gate__spinner" aria-hidden="true" />
            <div>
              <strong>Looking for a saved SSO session</strong>
              <p>The app will open automatically after the check.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="character-gate__intro">
              Intel works after signing in through official EVE Online SSO.
              Your password stays with EVE Online.
            </p>

            <form className="character-gate__form" onSubmit={onConnect}>
              <div className="character-gate__callback">
                <div>
                  <span>Official Fly Safe application</span>
                  <small>
                    {account?.sessionOnly
                      ? 'On macOS, sign-in lasts until Fly Safe closes · no Keychain prompt'
                      : 'OAuth configuration is already included in the installer'}
                  </small>
                </div>
                <code>{EVE_SSO_CALLBACK_URI}</code>
              </div>

              {error ? (
                <div className="character-gate__error" role="alert" aria-live="polite">
                  <AlertIcon />
                  <span>{error}</span>
                </div>
              ) : null}

              <button
                className="character-gate__connect"
                type="submit"
                disabled={connecting}
              >
                {connecting ? (
                  <>
                    <span className="character-gate__button-spinner" aria-hidden="true" />
                    Waiting for browser sign-in…
                  </>
                ) : (
                  <>
                    <EveIcon />
                    Sign in with EVE Online
                  </>
                )}
              </button>
            </form>

            <div className="character-gate__actions">
              {connecting ? (
                <button type="button" onClick={onCancelConnect} disabled={cancelling}>
                  {cancelling ? 'Cancelling…' : 'Cancel sign-in'}
                </button>
              ) : (
                <button type="button" onClick={onRetry}>Check saved sign-in</button>
              )}
            </div>
          </>
        )}

        <footer className="character-gate__footer">
          <ShieldIcon />
          <span>System, Local, and pilot data do not load before sign-in.</span>
        </footer>
      </section>
    </main>
  )
}

export function readCharacterGateError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Unknown EVE SSO error'
}

function PilotIcon(): ReactNode {
  return (
    <svg viewBox="0 0 32 32">
      <circle cx="16" cy="11" r="5" />
      <path d="M6.5 27c.8-6.1 4-9.2 9.5-9.2s8.7 3.1 9.5 9.2" />
    </svg>
  )
}

function AlertIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v5m0 3v.1" />
    </svg>
  )
}

function EveIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5v17M6 6l12 12M18 6 6 18" />
    </svg>
  )
}

function ShieldIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 5 6v5c0 4.6 2.5 7.7 7 10 4.5-2.3 7-5.4 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-5" />
    </svg>
  )
}
