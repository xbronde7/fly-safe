import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import type { LicenseStatus } from '../../shared/license'
import type {
  SubscriptionAccessStatus,
  SubscriptionInvoice,
  SubscriptionPlan
} from '../../shared/subscription'
import './license-gate.css'

export type LicenseGateStatus =
  | { state: 'checking'; deviceCode?: string }
  | LicenseStatus

export interface LicenseActivationResult {
  ok?: boolean
  active?: boolean
  message?: string | null
}

export interface LicenseGateProps {
  status: LicenseGateStatus
  onActivate: (licenseKey: string) => Promise<LicenseActivationResult | void>
  onCopyDeviceCode?: (deviceCode: string) => Promise<void> | void
  subscriptionStatus?: SubscriptionAccessStatus | null
  subscriptionPlans?: readonly SubscriptionPlan[]
  subscriptionPlansLoading?: boolean
  subscriptionPlansError?: string | null
  onRefreshSubscriptionPlans?: () => Promise<readonly SubscriptionPlan[]>
  onCreateInvoice?: (planId: string) => Promise<SubscriptionInvoice>
  onRefreshSubscription?: () => Promise<SubscriptionAccessStatus>
  children: ReactNode
}

export function normalizeLicenseKey(value: string): string {
  return value.replace(/\s+/g, '')
}

export function LicenseGate({
  status,
  onActivate,
  onCopyDeviceCode,
  subscriptionStatus = null,
  subscriptionPlans = [],
  subscriptionPlansLoading = false,
  subscriptionPlansError = null,
  onRefreshSubscriptionPlans,
  onCreateInvoice,
  onRefreshSubscription,
  children
}: LicenseGateProps): ReactNode {
  const [licenseKey, setLicenseKey] = useState('')
  const [activating, setActivating] = useState(false)
  const [activationMessage, setActivationMessage] = useState<string>()
  const [activationSucceeded, setActivationSucceeded] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [subscriptionBusy, setSubscriptionBusy] = useState(false)
  const [subscriptionMessage, setSubscriptionMessage] = useState<string>()
  const [invoice, setInvoice] = useState<SubscriptionInvoice | null>(null)

  useEffect(() => {
    setActivationMessage(undefined)
    setActivationSucceeded(false)
  }, [status.state])

  if ('active' in status && status.active) return children

  const deviceCode = status.deviceCode
  const isChecking = status.state === 'checking'
  const normalizedKey = normalizeLicenseKey(licenseKey)
  const submitDisabled = isChecking || activating || !deviceCode || normalizedKey.length === 0
  const visibleError = activationMessage ?? ('message' in status ? status.message ?? undefined : undefined)

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (submitDisabled) return

    setActivating(true)
    setActivationMessage(undefined)
    setActivationSucceeded(false)

    try {
      const result = await onActivate(normalizedKey)
      if (result && (result.ok === false || result.active === false)) {
        setActivationMessage(result.message || 'Ключ не принят. Проверьте его и попробуйте снова.')
        return
      }
      setActivationSucceeded(true)
      setActivationMessage(result?.message || 'Ключ принят. Открываем приложение…')
    } catch (error) {
      setActivationMessage(readActivationError(error))
    } finally {
      setActivating(false)
    }
  }

  async function handleCopy(): Promise<void> {
    if (!deviceCode || !onCopyDeviceCode) return
    setCopyState('idle')
    try {
      await onCopyDeviceCode(deviceCode)
      setCopyState('copied')
    } catch {
      setCopyState('error')
    }
  }

  async function handleCreateInvoice(planId: string): Promise<void> {
    if (!onCreateInvoice || subscriptionBusy) return
    setSubscriptionBusy(true)
    setSubscriptionMessage(undefined)
    try {
      setInvoice(await onCreateInvoice(planId))
    } catch (error) {
      setSubscriptionMessage(readActivationError(error))
    } finally {
      setSubscriptionBusy(false)
    }
  }

  async function handleSubscriptionRefresh(): Promise<void> {
    if (!onRefreshSubscription || subscriptionBusy) return
    setSubscriptionBusy(true)
    setSubscriptionMessage(undefined)
    try {
      const next = await onRefreshSubscription()
      setSubscriptionMessage(
        next.state === 'active' || next.state === 'grace'
          ? 'Оплата подтверждена. Entitlement обновлён.'
          : next.message || 'Платёж пока не найден. Проверим снова автоматически.'
      )
    } catch (error) {
      setSubscriptionMessage(readActivationError(error))
    } finally {
      setSubscriptionBusy(false)
    }
  }

  return (
    <main className="license-gate" aria-labelledby="license-gate-title">
      <div className="license-gate__drag-strip" aria-hidden="true" />
      <div className="license-gate__orbit license-gate__orbit--one" aria-hidden="true" />
      <div className="license-gate__orbit license-gate__orbit--two" aria-hidden="true" />

      <section className="license-gate__card">
        <header className="license-gate__header">
          <div className="license-gate__mark" aria-hidden="true">
            <svg viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="12" />
              <path d="M4 20h32M20 4v32M11.5 11.5l17 17M28.5 11.5l-17 17" />
              <circle className="license-gate__mark-core" cx="20" cy="20" r="3.5" />
            </svg>
          </div>
          <div>
            <p className="license-gate__eyebrow">FLY SAFE · ЗАКРЫТЫЙ ДОСТУП</p>
            <h1 id="license-gate-title">
              {isChecking ? 'Проверяем лицензию…' : 'Введите ключ доступа'}
            </h1>
          </div>
        </header>

        {isChecking ? (
          <div className="license-gate__checking" role="status" aria-live="polite">
            <span className="license-gate__spinner" aria-hidden="true" />
            <div>
              <strong>Проверяем это устройство</strong>
              <p>Это займёт несколько секунд.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="license-gate__intro">
              Приложение доступно только по персональному ключу. Ключ привязывается к этому компьютеру.
            </p>

            <div className="license-gate__device">
              <div className="license-gate__field-heading">
                <label htmlFor="license-device-code">Код устройства</label>
                <span>Отправьте его при запросе ключа</span>
              </div>
              <div className="license-gate__device-row">
                <code id="license-device-code">{deviceCode || 'Код устройства недоступен'}</code>
                {deviceCode && onCopyDeviceCode ? (
                  <button
                    className="license-gate__copy"
                    type="button"
                    onClick={() => void handleCopy()}
                    aria-label="Скопировать код устройства"
                  >
                    {copyState === 'copied' ? (
                      <>
                        <CheckIcon /> Скопировано
                      </>
                    ) : (
                      <>
                        <CopyIcon /> Копировать
                      </>
                    )}
                  </button>
                ) : null}
              </div>
              {copyState === 'error' ? (
                <p className="license-gate__copy-error" role="alert">
                  Не удалось скопировать. Выделите код вручную.
                </p>
              ) : null}
            </div>

            {subscriptionStatus?.backendConfigured ? (
              <section className="license-gate__subscription" aria-label="Подписка за ISK">
                <div className="license-gate__field-heading">
                  <strong>Подписка за ISK</strong>
                  <span>Оплата вручную в EVE; выдача автоматическая</span>
                </div>

                {subscriptionPlans.length > 0 ? (
                  <>
                    <div className="license-gate__plans">
                      {subscriptionPlans.map((plan) => (
                        <button
                          type="button"
                          key={plan.id}
                          disabled={subscriptionBusy}
                          onClick={() => void handleCreateInvoice(plan.id)}
                        >
                          <strong>{plan.name}</strong>
                          <span>{formatInvoiceIsk(plan.amountIsk)} ISK</span>
                        </button>
                      ))}
                    </div>
                    {subscriptionPlansError ? (
                      <SubscriptionPlansUnavailable
                        message={`Не удалось обновить тарифы: ${subscriptionPlansError}. Показан последний загруженный список.`}
                        loading={subscriptionPlansLoading}
                        onRetry={onRefreshSubscriptionPlans}
                      />
                    ) : subscriptionPlansLoading ? (
                      <p className="license-gate__subscription-note" role="status">
                        Обновляем тарифы…
                      </p>
                    ) : null}
                  </>
                ) : subscriptionPlansLoading ? (
                  <p className="license-gate__subscription-note" role="status">
                    Тарифы загружаются…
                  </p>
                ) : (
                  <SubscriptionPlansUnavailable
                    message={subscriptionPlansError
                      ? `Тарифы временно недоступны: ${subscriptionPlansError}`
                      : 'Доступных тарифов сейчас нет.'}
                    loading={subscriptionPlansLoading}
                    onRetry={onRefreshSubscriptionPlans}
                  />
                )}

                {(invoice ?? subscriptionStatus.invoice) ? (
                  <InvoicePaymentCard invoice={(invoice ?? subscriptionStatus.invoice)!} />
                ) : null}

                <button
                  type="button"
                  className="license-gate__refresh-subscription"
                  disabled={subscriptionBusy}
                  onClick={() => void handleSubscriptionRefresh()}
                >
                  {subscriptionBusy ? 'Проверяем…' : 'Я оплатил · проверить entitlement'}
                </button>
                {(subscriptionMessage || subscriptionStatus.message) ? (
                  <p className="license-gate__subscription-note" role="status">
                    {subscriptionMessage ?? subscriptionStatus.message}
                  </p>
                ) : null}
              </section>
            ) : null}

            <form className="license-gate__form" onSubmit={(event) => void handleSubmit(event)}>
              <div className="license-gate__field-heading">
                <label htmlFor="license-key">Резервный лицензионный ключ</label>
                <span>Для поддержки и offline-активаций</span>
              </div>
              <textarea
                id="license-key"
                rows={3}
                value={licenseKey}
                onChange={(event) => {
                  setLicenseKey(event.currentTarget.value)
                  setActivationMessage(undefined)
                  setActivationSucceeded(false)
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="Вставьте ключ сюда"
                aria-invalid={Boolean(visibleError) && !activationSucceeded}
                aria-describedby={visibleError ? 'license-gate-message' : 'license-gate-key-hint'}
                autoFocus
              />
              <span id="license-gate-key-hint" className="sr-only">
                Вставьте персональный ключ доступа для этого компьютера.
              </span>

              {visibleError ? (
                <div
                  id="license-gate-message"
                  className={`license-gate__message${activationSucceeded ? ' is-success' : ''}`}
                  role={activationSucceeded ? 'status' : 'alert'}
                  aria-live="polite"
                >
                  {activationSucceeded ? <CheckIcon /> : <AlertIcon />}
                  <span>{visibleError}</span>
                </div>
              ) : null}

              <button className="license-gate__activate" type="submit" disabled={submitDisabled}>
                {activating ? (
                  <>
                    <span className="license-gate__button-spinner" aria-hidden="true" />
                    Активируем…
                  </>
                ) : (
                  <>
                    <KeyIcon /> Активировать ключ
                  </>
                )}
              </button>
            </form>
          </>
        )}

        <footer className="license-gate__footer">
          <LockIcon />
          <span>Без действующего ключа разведка и данные пилотов не загружаются.</span>
        </footer>
      </section>
    </main>
  )
}

function SubscriptionPlansUnavailable({
  message,
  loading,
  onRetry
}: {
  message: string
  loading: boolean
  onRetry?: () => Promise<readonly SubscriptionPlan[]>
}): ReactNode {
  return (
    <div className="license-gate__plans-unavailable" role="status">
      <p className="license-gate__subscription-note">{message}</p>
      {onRetry ? (
        <button
          type="button"
          className="license-gate__retry-plans"
          disabled={loading}
          onClick={() => { void onRetry().catch(() => undefined) }}
        >
          {loading ? 'Загружаем…' : 'Повторить загрузку тарифов'}
        </button>
      ) : null}
    </div>
  )
}

function InvoicePaymentCard({ invoice }: { invoice: SubscriptionInvoice }): ReactNode {
  return (
    <div className="license-gate__invoice">
      <span>Переведите персонажу ID</span>
      <code>{invoice.receiverCharacterName ?? invoice.receiverCharacterId}</code>
      <span>Точная сумма</span>
      <strong>{formatInvoiceIsk(invoice.amountIsk)} ISK</strong>
      <span>Reason-код, если поле доступно</span>
      <code>{invoice.paymentCode}</code>
      <small>
        Invoice действует до {formatInvoiceDate(invoice.expiresAt)}. Платите вошедшим чаром,
        не округляйте сумму. Если поле Reason доступно — вставьте FS-код. Без Reason платёж
        сверяется по чару и точной сумме; неоднозначный платёж потребует ручной проверки.
      </small>
    </div>
  )
}

function formatInvoiceIsk(value: string): string {
  const [whole, fraction] = value.split('.')
  const formatted = new Intl.NumberFormat('ru-RU').format(BigInt(whole))
  return fraction && fraction !== '00' ? `${formatted},${fraction}` : formatted
}

function formatInvoiceDate(value: number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value * 1_000))
}

function readActivationError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Не удалось проверить ключ. Попробуйте ещё раз.'
}

function CopyIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  )
}

function CheckIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
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

function KeyIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8m-3 3 2 2m-5 1 2 2" />
    </svg>
  )
}

function LockIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  )
}
