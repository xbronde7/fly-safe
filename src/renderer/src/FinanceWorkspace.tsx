import { useCallback, useEffect, useState } from 'react'
import type {
  EconomyAssetTypeSummary,
  PersonalEconomySnapshot
} from '../../shared/personal-economy'
import { EveTypeImage } from './EveTypeImage'

interface FinanceApi {
  getPersonalEconomy(request?: { forceRefresh?: boolean }): Promise<PersonalEconomySnapshot>
}

export function FinanceWorkspace({
  api,
  active
}: {
  api: FinanceApi | null
  active: boolean
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<PersonalEconomySnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (forceRefresh = false): Promise<void> => {
    if (!api) {
      setError('Desktop app bridge unavailable')
      return
    }
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await api.getPersonalEconomy({ forceRefresh }))
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (active && snapshot === null && !loading) void load()
  }, [active, load, loading, snapshot])

  return (
    <section className="finance-shell" aria-labelledby="finance-title">
      <div className="workspace-hero finance-hero">
        <div>
          <p className="eyebrow">EVE SSO · your data only</p>
          <h1 id="finance-title">My finances</h1>
          <p>Wallet, orders, transactions, and an estimated asset value.</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={!api || loading}
          onClick={() => void load(true)}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="workspace-inline-error" role="alert">{error}</div>}
      {loading && snapshot === null && <div className="workspace-loading">Loading personal ESI data…</div>}

      {snapshot && (
        <>
          {snapshot.missingScopes.length > 0 && (
            <div className="scope-warning" role="status">
              <strong>Some data needs additional EVE SSO permissions</strong>
              <p>
                Enable the listed scopes in EVE Developers, then disconnect and reconnect your
                character. Existing permissions continue to work.
              </p>
              <code>{snapshot.missingScopes.join(' · ')}</code>
            </div>
          )}

          <div className="finance-summary-grid">
            <Metric label="Wallet" value={formatIsk(snapshot.balance)} detail="ESI balance" />
            <Metric
              label="Assets"
              value={formatIsk(snapshot.assets.estimatedValue)}
              detail={`Types priced: ${snapshot.assets.pricedTypeCount}/${snapshot.assets.typeCount}`}
            />
            <Metric
              label="Sell orders"
              value={formatIsk(snapshot.orders.sellGrossRemaining)}
              detail={`${snapshot.orders.sellCount} sell · ${snapshot.orders.buyCount} buy`}
            />
            <Metric
              label="Trade flow · 30 d"
              value={signedIsk(snapshot.trade30d.net)}
              detail={`Sales ${formatIsk(snapshot.trade30d.sales)} · buys ${formatIsk(snapshot.trade30d.buys)}`}
              tone={snapshot.trade30d.net >= 0 ? 'positive' : 'negative'}
            />
          </div>

          <section className="finance-panel finance-assets-panel">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Assets · estimated value</p>
                <h2>Most valuable assets</h2>
              </div>
              <span className="workspace-count">{snapshot.assets.typeCount}</span>
            </div>
            {snapshot.assets.top.length === 0 ? (
              <Empty text="Assets not retrieved or the scope is not connected yet." />
            ) : (
              <FinanceAssetList assets={snapshot.assets.top.slice(0, 50)} />
            )}
            <p className="data-boundary-note">
              Asset valuation uses the public ESI average/adjusted price, not a guaranteed
              immediate-sale price in Jita. Check exact prices in the Market tab.
            </p>
          </section>

          <section className="finance-panel">
            <div className="section-heading compact">
              <div><p className="eyebrow">Market orders</p><h2>Open orders</h2></div>
              <span className="workspace-count">{snapshot.orders.open.length}</span>
            </div>
            {snapshot.orders.open.length === 0 ? <Empty text="No open orders or the scope is not connected." /> : (
              <div className="finance-order-grid">
                {snapshot.orders.open.slice(0, 40).map((order) => (
                  <article key={order.orderId} className={`finance-order ${order.buyOrder ? 'buy' : 'sell'}`}>
                    <EveTypeImage typeId={order.typeId} variant="icon" requestSize={64} />
                    <div>
                      <strong>{order.typeName ?? `Type ${order.typeId}`}</strong>
                      <small>{order.buyOrder ? 'BUY' : 'SELL'} · remaining {formatNumber(order.volumeRemain)}</small>
                    </div>
                    <div><strong>{formatIsk(order.price)}</strong><small>per unit</small></div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="finance-panel">
            <div className="section-heading compact">
              <div><p className="eyebrow">Wallet transactions</p><h2>Recent transactions</h2></div>
              <span className="workspace-count">{snapshot.transactions.length}</span>
            </div>
            {snapshot.transactions.length === 0 ? <Empty text="Transactions not retrieved or the scope is not connected." /> : (
              <div className="finance-transaction-list">
                {snapshot.transactions.slice(0, 50).map((transaction) => (
                  <article key={transaction.transactionId}>
                    <span className={transaction.buy ? 'negative' : 'positive'}>{transaction.buy ? 'BUY' : 'SELL'}</span>
                    <div><strong>{transaction.typeName ?? `Type ${transaction.typeId}`}</strong><small>{formatDate(transaction.date)} · ×{formatNumber(transaction.quantity)}</small></div>
                    <b>{transaction.buy ? '−' : '+'}{formatIsk(transaction.gross)}</b>
                  </article>
                ))}
              </div>
            )}
          </section>

          {snapshot.warnings.length > 0 && (
            <div className="workspace-warning-list">{snapshot.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
          )}
          <p className="workspace-updated">Updated: {formatDate(snapshot.fetchedAt)}</p>
        </>
      )}
    </section>
  )
}

export function FinanceAssetList({
  assets
}: {
  assets: readonly EconomyAssetTypeSummary[]
}): React.JSX.Element {
  return (
    <div className="finance-asset-list" role="list" aria-label="Most valuable assets">
      {assets.map((asset) => {
        const [primaryLocation, ...additionalLocations] = asset.locationDetails
        const assetName = asset.typeName ?? `Type ${asset.typeId}`

        return (
          <article className="finance-asset-row" role="listitem" key={asset.typeId}>
            <EveTypeImage typeId={asset.typeId} variant="icon" requestSize={64} />
            <div className="finance-asset-main">
              <strong title={assetName}>{assetName}</strong>
              <small className="finance-asset-meta">
                {unitCountLabel(asset.quantity)} · {stackCountLabel(asset.stacks)}
              </small>
              <span
                className={`finance-asset-location${primaryLocation?.unresolved ? ' unresolved' : ''}`}
                title={primaryLocation
                  ? primaryLocation.unresolved
                    ? 'Could not retrieve location name'
                    : locationName(primaryLocation)
                  : undefined}
              >
                <span aria-hidden="true">⌖</span>
                <span>{primaryLocation ? locationName(primaryLocation) : 'Location not identified'}</span>
                {primaryLocation && additionalLocations.length > 0 && (
                  <small>{unitCountLabel(primaryLocation.quantity)}</small>
                )}
              </span>
            </div>
            <div className="finance-asset-value">
              <strong>{formatIsk(asset.estimatedValue)}</strong>
              <small>estimate</small>
            </div>
            {additionalLocations.length > 0 && (
              <details className="finance-asset-locations">
                <summary>{additionalLocationLabel(additionalLocations.length)}</summary>
                <div className="finance-asset-location-list">
                  {additionalLocations.map((location) => (
                    <div
                      className={location.unresolved ? 'unresolved' : undefined}
                      key={`${location.locationType}:${location.locationId}`}
                    >
                      <span title={location.unresolved
                        ? 'Could not retrieve location name'
                        : locationName(location)}>
                        {locationName(location)}
                      </span>
                      <small>
                        {unitCountLabel(location.quantity)} · {stackCountLabel(location.stacks)}
                      </small>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </article>
        )
      })}
    </div>
  )
}

function locationName(
  location: EconomyAssetTypeSummary['locationDetails'][number]
): string {
  if (location.locationName) return location.locationName
  if (location.locationType === 'station') return `Station #${location.locationId}`
  if (location.locationType === 'solar_system') return `System #${location.locationId}`
  if (location.locationType === 'structure') return `Structure #${location.locationId}`
  return `Location #${location.locationId}`
}

function stackCountLabel(count: number): string {
  return `${count} stack${count === 1 ? '' : 's'}`
}

function unitCountLabel(count: number): string {
  return `${formatNumber(count)} unit${count === 1 ? '' : 's'}`
}

function additionalLocationLabel(count: number): string {
  return `${count} more location${count === 1 ? '' : 's'}`
}

function Metric({
  label,
  value,
  detail,
  tone = 'neutral'
}: {
  label: string
  value: string
  detail: string
  tone?: 'neutral' | 'positive' | 'negative'
}): React.JSX.Element {
  return <article className={`finance-metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <div className="workspace-empty">{text}</div>
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}

function formatIsk(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: value < 1_000 ? 2 : 0 }).format(value)} ISK`
}

function signedIsk(value: number): string {
  return `${value >= 0 ? '+' : '−'}${formatIsk(Math.abs(value))}`
}

function formatDate(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(time)
    : value
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error'
}
