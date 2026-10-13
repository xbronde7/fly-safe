import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MARKET_HUBS,
  normalizeMarketItemInput,
  type MarketAppraisal,
  type MarketAppraisalRequest,
  type MarketComparisonRequest,
  type MarketHistoryPoint,
  type MarketHubComparison,
  type MarketHubQuote,
  type MarketTypeSearchMatch
} from '../../shared/market'
import { EveTypeImage } from './EveTypeImage'
import { MarketOrderDepthDialog } from './MarketOrderDepth'

interface MarketApi {
  searchInventoryTypes(
    query: string,
    limit?: number,
    forceRefresh?: boolean
  ): Promise<MarketTypeSearchMatch[]>
  compareMarketHubs(request: MarketComparisonRequest): Promise<MarketHubComparison>
  appraiseMarketText(request: MarketAppraisalRequest): Promise<MarketAppraisal>
  readClipboard(): Promise<string>
}

type MarketMode = 'single' | 'appraisal'
type HistoryPeriod = 7 | 30

const ALL_HUB_IDS = MARKET_HUBS.map((hub) => hub.id)
const MARKET_DRAFT_EVENT = 'fly-safe:market-draft'

export function MarketWorkspace({
  api,
  active
}: {
  api: MarketApi | null
  active: boolean
}): React.JSX.Element {
  const [mode, setMode] = useState<MarketMode>('single')
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<MarketTypeSearchMatch[]>([])
  const [selected, setSelected] = useState<MarketTypeSearchMatch | null>(null)
  const [quantityText, setQuantityText] = useState('1')
  const [historyPeriod, setHistoryPeriod] = useState<HistoryPeriod>(7)
  const [comparison, setComparison] = useState<MarketHubComparison | null>(null)
  const [searching, setSearching] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [singleError, setSingleError] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchSequence = useRef(0)
  const searchBoxRef = useRef<HTMLDivElement>(null)

  const [appraisalText, setAppraisalText] = useState('')
  const [appraisal, setAppraisal] = useState<MarketAppraisal | null>(null)
  const [appraising, setAppraising] = useState(false)
  const [appraisalError, setAppraisalError] = useState<string | null>(null)

  const quantity = parseQuantity(quantityText)
  const canCompare = api !== null && selected !== null && quantity !== null && !comparing
  const canAppraise = api !== null && appraisalText.trim().length > 0 && !appraising

  useEffect(() => {
    if (!active) setSearchOpen(false)
  }, [active])

  useEffect(() => {
    const receiveFit = (event: Event): void => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail
      if (typeof detail?.text !== 'string' || !detail.text.trim()) return
      setMode('appraisal')
      setAppraisalText(detail.text)
      setAppraisal(null)
      setAppraisalError(null)
      if (api) {
        setAppraising(true)
        void api.appraiseMarketText({ text: detail.text, hubIds: ALL_HUB_IDS })
          .then(setAppraisal)
          .catch((caught) => setAppraisalError(messageOf(caught)))
          .finally(() => setAppraising(false))
      }
    }
    window.addEventListener(MARKET_DRAFT_EVENT, receiveFit)
    return () => window.removeEventListener(MARKET_DRAFT_EVENT, receiveFit)
  }, [api])

  useEffect(() => {
    const closeSearch = (event: MouseEvent): void => {
      if (!searchBoxRef.current?.contains(event.target as Node)) setSearchOpen(false)
    }
    document.addEventListener('mousedown', closeSearch)
    return () => document.removeEventListener('mousedown', closeSearch)
  }, [])

  useEffect(() => {
    const normalizedQuery = normalizeMarketItemInput(query)
    if (selected && normalizedQuery === selected.name) {
      setMatches([])
      setSearching(false)
      return
    }
    if (!isSearchable(normalizedQuery) || !api) {
      searchSequence.current += 1
      setMatches([])
      setSearching(false)
      return
    }

    const sequence = ++searchSequence.current
    setSearching(true)
    const timer = window.setTimeout(() => {
      void api.searchInventoryTypes(normalizedQuery, 12)
        .then((result) => {
          if (sequence !== searchSequence.current) return
          setMatches(result)
          setSearchOpen(true)
        })
        .catch((caught) => {
          if (sequence !== searchSequence.current) return
          setMatches([])
          setSingleError(messageOf(caught))
        })
        .finally(() => {
          if (sequence === searchSequence.current) setSearching(false)
        })
    }, 280)
    return () => window.clearTimeout(timer)
  }, [api, query, selected])

  const compare = useCallback(async (
    item: MarketTypeSearchMatch,
    forceRefresh = false
  ): Promise<void> => {
    if (!api) {
      setSingleError('Desktop app bridge unavailable')
      return
    }
    const parsedQuantity = parseQuantity(quantityText)
    if (parsedQuantity === null) {
      setSingleError('Quantity must be a positive whole number')
      return
    }
    setComparing(true)
    setSingleError(null)
    try {
      setComparison(await api.compareMarketHubs({
        typeId: item.typeId,
        quantity: parsedQuantity,
        hubIds: ALL_HUB_IDS,
        includeHistory: true,
        includeDepth: true,
        forceRefresh
      }))
    } catch (caught) {
      setSingleError(messageOf(caught))
    } finally {
      setComparing(false)
    }
  }, [api, quantityText])

  const selectItem = (item: MarketTypeSearchMatch): void => {
    searchSequence.current += 1
    setSelected(item)
    setQuery(item.name)
    setMatches([])
    setSearchOpen(false)
    setComparison(null)
    void compare(item)
  }

  const runAppraisal = useCallback(async (forceRefresh = false): Promise<void> => {
    if (!api || !appraisalText.trim()) return
    setAppraising(true)
    setAppraisalError(null)
    try {
      setAppraisal(await api.appraiseMarketText({
        text: appraisalText,
        hubIds: ALL_HUB_IDS,
        forceRefresh
      }))
    } catch (caught) {
      setAppraisalError(messageOf(caught))
    } finally {
      setAppraising(false)
    }
  }, [api, appraisalText])

  const pasteClipboard = async (): Promise<void> => {
    if (!api) return
    setAppraisalError(null)
    try {
      const text = await api.readClipboard()
      if (!text.trim()) throw new Error('Clipboard is empty')
      setAppraisalText(text)
      setAppraisal(null)
    } catch (caught) {
      setAppraisalError(messageOf(caught))
    }
  }

  return (
    <section className="market-shell" aria-labelledby="market-title">
      <div className="workspace-hero market-hero">
        <div>
          <p className="eyebrow">ESI Market · five trade hubs</p>
          <h1 id="market-title">Market</h1>
          <p>Live station orders, order-book depth, and a quick valuation of a list or EFT fit.</p>
        </div>
        <div className="market-mode-switch" role="tablist" aria-label="Market mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'single'}
            className={mode === 'single' ? 'active' : ''}
            onClick={() => setMode('single')}
          >Item</button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'appraisal'}
            className={mode === 'appraisal' ? 'active' : ''}
            onClick={() => setMode('appraisal')}
          >List / EFT</button>
        </div>
      </div>

      {mode === 'single' ? (
        <div role="tabpanel">
          <section className="market-search-panel">
            <div className="market-type-search" ref={searchBoxRef}>
              <label htmlFor="market-item-query">Item or type ID</label>
              <div className="market-search-input-wrap">
                <input
                  id="market-item-query"
                  value={query}
                  autoComplete="off"
                  placeholder="For example: Ishtar"
                  role="combobox"
                  onFocus={() => matches.length > 0 && setSearchOpen(true)}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setSelected(null)
                    setComparison(null)
                    setSingleError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && matches[0]) {
                      event.preventDefault()
                      selectItem(matches[0])
                    }
                    if (event.key === 'Escape') setSearchOpen(false)
                  }}
                  aria-autocomplete="list"
                  aria-expanded={searchOpen}
                  aria-controls="market-search-results"
                />
                <span className={searching ? 'market-search-spinner active' : 'market-search-spinner'} aria-hidden="true" />
              </div>
              {searchOpen && (
                <div id="market-search-results" className="market-search-results" role="listbox">
                  {matches.length > 0 ? matches.map((match) => (
                    <button
                      key={match.typeId}
                      type="button"
                      role="option"
                      aria-selected={selected?.typeId === match.typeId}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectItem(match)}
                    >
                      <EveTypeImage typeId={match.typeId} variant="icon" requestSize={64} />
                      <span><strong>{match.name}</strong><small>Type {match.typeId}</small></span>
                      {match.exact && <b>exact</b>}
                    </button>
                  )) : !searching && (
                    <div className="market-search-empty">No matches found</div>
                  )}
                </div>
              )}
            </div>

            <label className="market-quantity-field" htmlFor="market-quantity">
              <span>Quantity</span>
              <input
                id="market-quantity"
                inputMode="numeric"
                value={quantityText}
                className={quantity === null ? 'invalid' : ''}
                onChange={(event) => setQuantityText(event.target.value.replace(/[^\d]/g, ''))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && selected && canCompare) void compare(selected)
                }}
              />
            </label>
            <button
              type="button"
              className="primary-button"
              disabled={!canCompare}
              onClick={() => selected && void compare(selected)}
            >{comparing ? 'Comparing…' : 'Compare hubs'}</button>
          </section>

          {singleError && <div className="workspace-inline-error" role="alert">{singleError}</div>}
          {comparing && comparison === null && <div className="workspace-loading">Loading orders and history for five ESI regions…</div>}

          {comparison && selected && (
            <MarketComparisonView
              item={selected}
              comparison={comparison}
              period={historyPeriod}
              loading={comparing}
              onPeriodChange={setHistoryPeriod}
              onRefresh={() => void compare(selected, true)}
            />
          )}
        </div>
      ) : (
        <div role="tabpanel">
          <section className="market-appraisal-input">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Clipboard · Multibuy · EFT</p>
                <h2>Value a list</h2>
              </div>
              <button type="button" className="secondary-button" disabled={!api || appraising} onClick={() => void pasteClipboard()}>
                Paste from clipboard
              </button>
            </div>
            <textarea
              value={appraisalText}
              spellCheck={false}
              placeholder={'[Ishtar, Travel]\nDamage Control II\nLarge Shield Extender II x2\nNanite Repair Paste\t500'}
              onChange={(event) => {
                setAppraisalText(event.target.value)
                setAppraisal(null)
                setAppraisalError(null)
              }}
            />
            <div className="market-appraisal-actions">
              <p>Understands inventory, Multibuy, and EFT lines. Buying uses sell orders; immediate sale uses buy orders.</p>
              {appraisal && (
                <button type="button" className="secondary-button" disabled={appraising} onClick={() => void runAppraisal(true)}>
                  Refresh without cache
                </button>
              )}
              <button type="button" className="primary-button" disabled={!canAppraise} onClick={() => void runAppraisal()}>
                {appraising ? 'Valuing…' : 'Value at all hubs'}
              </button>
            </div>
          </section>

          {appraisalError && <div className="workspace-inline-error" role="alert">{appraisalError}</div>}
          {appraising && appraisal === null && <div className="workspace-loading">Parsing the list and checking hub order books…</div>}
          {appraisal && <MarketAppraisalView appraisal={appraisal} loading={appraising} />}
        </div>
      )}
    </section>
  )
}

function MarketComparisonView({
  item,
  comparison,
  period,
  loading,
  onPeriodChange,
  onRefresh
}: {
  item: MarketTypeSearchMatch
  comparison: MarketHubComparison
  period: HistoryPeriod
  loading: boolean
  onPeriodChange: (period: HistoryPeriod) => void
  onRefresh: () => void
}): React.JSX.Element {
  const [depthHub, setDepthHub] = useState<string | null>(null)
  const depthQuote = comparison.quotes.find(q => q.hub.id === depthHub)
  const cheapest = useMemo(() => minimumQuote(comparison.quotes, 'buy'), [comparison.quotes])
  const bestSale = useMemo(() => minimumQuote(comparison.quotes, 'sell'), [comparison.quotes])

  return (
    <section className="market-results">
      <div className="market-results-heading">
        <div className="market-selected-type">
          <EveTypeImage typeId={item.typeId} variant="icon" requestSize={64} />
          <span><small>Type {item.typeId} · quantity {formatNumber(comparison.quantity)}</small><strong>{item.name}</strong></span>
        </div>
        <div className="market-best-summary">
          <span>Cheapest to buy <b>{cheapest ? cheapest.hub.name : '—'}</b></span>
          <span>Best to sell <b>{bestSale ? bestSale.hub.name : '—'}</b></span>
        </div>
        <div className="market-history-period" aria-label="Chart period">
          <button type="button" className={period === 7 ? 'active' : ''} onClick={() => onPeriodChange(7)}>7 d</button>
          <button type="button" className={period === 30 ? 'active' : ''} onClick={() => onPeriodChange(30)}>30 d</button>
        </div>
        <button type="button" className="secondary-button" disabled={loading} onClick={onRefresh}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="market-hub-grid">
        {comparison.quotes.map((quote) => (
          <HubQuoteCard
            key={quote.hub.id}
            quote={quote}
            period={period}
            cheapest={cheapest?.hub.id === quote.hub.id}
            bestSale={bestSale?.hub.id === quote.hub.id}
            onDepth={() => setDepthHub(quote.hub.id)}
          />
        ))}
      </div>

      {depthQuote && <MarketOrderDepthDialog key={`${comparison.typeId}:${depthQuote.hub.id}`} quote={depthQuote} onClose={() => setDepthHub(null)} />}

      <p className="market-history-boundary">
        Charts and volume cover the whole region for the selected period. Prices, spread, and order-book depth use only the selected hub station's orders.
      </p>
      <p className="workspace-updated">
        {comparison.cached ? 'From cache' : 'Retrieved from ESI'} · {formatDate(comparison.fetchedAt)}
      </p>
    </section>
  )
}

export function HubQuoteCard({
  quote,
  period,
  cheapest,
  bestSale,
  onDepth
}: {
  quote: MarketHubQuote
  period: HistoryPeriod
  cheapest: boolean
  bestSale: boolean
  onDepth(): void
}): React.JSX.Element {
  const history = quote.history
  const points = history
    ? [...history.points].sort((left, right) => left.date.localeCompare(right.date)).slice(-period)
    : []
  const summary = history ? (period === 7 ? history.sevenDays : history.thirtyDays) : null

  return (
    <article className={`market-hub-card${cheapest || bestSale ? ' highlighted' : ''}`}>
      <header>
        <div><strong>{quote.hub.name}</strong><small>{compactStationName(quote.hub.stationName)}</small></div>
        <div className="market-hub-badges">
          {cheapest && <span className="buy">cheapest</span>}
          {bestSale && <span className="sell">best sale</span>}
        </div>
      </header>

      <div className="market-price-pair">
        <div>
          <span>Min. sell</span>
          <strong>{formatIsk(quote.book.bestSell)}</strong>
          <small>{formatNumber(quote.book.sellVolume)} units in book</small>
        </div>
        <div>
          <span>Max. buy</span>
          <strong>{formatIsk(quote.book.bestBuy)}</strong>
          <small>{formatNumber(quote.book.buyVolume)} units in book</small>
        </div>
      </div>

      <div className="market-executable-row">
        <div>
          <span>Buy {formatNumber(quote.quantity)}</span>
          <strong>{formatIsk(quote.book.immediateBuy.total)}</strong>
          <FillState complete={quote.book.immediateBuy.complete} filled={quote.book.immediateBuy.filledQuantity} requested={quote.quantity} />
        </div>
        <div>
          <span>Sell {formatNumber(quote.quantity)}</span>
          <strong>{formatIsk(quote.book.immediateSell.total)}</strong>
          <FillState complete={quote.book.immediateSell.complete} filled={quote.book.immediateSell.filledQuantity} requested={quote.quantity} />
        </div>
      </div>

      <div className="market-depth-meta">
        <span>Spread <b>{formatPercent(quote.book.spreadPercent)}</b></span>
        <span>Station orders <b>{formatNumber(quote.stationOrderCount)}</b></span>
      </div>

      <button type="button" className="secondary-button market-full-depth-button" onClick={onDepth}>Открыть стакан BUY / SELL</button>

      <div className="market-history-chart">
        <div><span>Region · {period} d</span><b>{formatIsk(summary?.weightedAverage ?? null)} average</b></div>
        <Sparkline points={points} chartId={quote.hub.id} />
        <div className="market-chart-meta">
          <span>low {formatIsk(summary?.lowest ?? null)}</span>
          <span>{formatNumber(summary?.volume ?? 0)} units</span>
          <span>high {formatIsk(summary?.highest ?? null)}</span>
        </div>
      </div>
    </article>
  )
}

function FillState({ complete, filled, requested }: { complete: boolean; filled: number; requested: number }): React.JSX.Element {
  return complete
    ? <small className="market-fill complete">enough depth</small>
    : <small className="market-fill incomplete">only {formatNumber(filled)} of {formatNumber(requested)}</small>
}

function Sparkline({ points, chartId }: { points: MarketHistoryPoint[]; chartId: string }): React.JSX.Element {
  const geometry = sparklineGeometry(points, chartId)
  if (!geometry) return <div className="market-chart-empty">No history</div>
  return (
    <svg viewBox="0 0 240 62" role="img" aria-label={`Average price history for ${points.length} days`} preserveAspectRatio="none">
      <defs>
        <linearGradient id={geometry.gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#38d8dc" stopOpacity=".22" />
          <stop offset="1" stopColor="#38d8dc" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" y1="31" x2="240" y2="31" className="market-chart-gridline" />
      <polygon points={geometry.area} fill={`url(#${geometry.gradientId})`} />
      <polyline points={geometry.line} className="market-chart-line" />
    </svg>
  )
}

function MarketAppraisalView({ appraisal, loading }: { appraisal: MarketAppraisal; loading: boolean }): React.JSX.Element {
  return (
    <section className={`market-appraisal-results${loading ? ' loading' : ''}`}>
      <div className="market-appraisal-totals">
        {appraisal.totals.map((total) => (
          <article key={total.hub.id}>
            <header><strong>{total.hub.name}</strong><small>{compactStationName(total.hub.stationName)}</small></header>
            <div><span>Buy all</span><b>{formatIsk(total.immediateBuyTotal)}</b></div>
            <div><span>Sell immediately</span><b>{formatIsk(total.immediateSellTotal)}</b></div>
            {(total.incompleteBuyItems > 0 || total.incompleteSellItems > 0) && (
              <p>Insufficient depth: buy {total.incompleteBuyItems}, sell {total.incompleteSellItems}</p>
            )}
          </article>
        ))}
      </div>

      {appraisal.items.length > 0 ? (
        <div className="market-appraisal-table-wrap">
          <table className="market-appraisal-table">
            <thead>
              <tr><th>Item</th><th>Qty.</th>{appraisal.totals.map((total) => <th key={total.hub.id}>{total.hub.name}</th>)}</tr>
            </thead>
            <tbody>
              {appraisal.items.map((item) => (
                <tr key={`${item.typeId}:${item.inputName}`}>
                  <td>
                    <span className="market-appraisal-item">
                      <EveTypeImage typeId={item.typeId} variant="icon" requestSize={64} />
                      <span><strong>{item.name}</strong>{item.inputName !== item.name && <small>from: {item.inputName}</small>}</span>
                    </span>
                  </td>
                  <td>{formatNumber(item.quantity)}</td>
                  {appraisal.totals.map((total) => {
                    const quote = item.quotes.find((entry) => entry.hub.id === total.hub.id)
                    return (
                      <td key={total.hub.id}>
                        {quote ? (
                          <span className="market-appraisal-prices">
                            <b title="Cost to buy from sell orders">{formatIsk(quote.book.immediateBuy.total)}</b>
                            <small title="Revenue from immediately selling to buy orders">sell {formatIsk(quote.book.immediateSell.total)}</small>
                            {(!quote.book.immediateBuy.complete || !quote.book.immediateSell.complete) && <em>incomplete order book</em>}
                          </span>
                        ) : '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="workspace-empty">No items to value were found in the list.</div>}

      {(appraisal.unresolved.length > 0 || appraisal.warnings.length > 0) && (
        <div className="market-appraisal-warnings">
          {appraisal.unresolved.length > 0 && (
            <p><strong>Not recognized:</strong> {appraisal.unresolved.map((item) => `${item.inputName} ×${item.quantity}`).join(' · ')}</p>
          )}
          {appraisal.warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      )}

      <div className="market-appraisal-footer">
        <span>{appraisal.items.length} items · rows skipped: {appraisal.ignoredLineCount}</span>
        <span>{appraisal.cached ? 'From cache' : 'Retrieved from ESI'} · {formatDate(appraisal.fetchedAt)}</span>
      </div>
      <p className="market-history-boundary">Totals use the available depth of station orders. If an order book is incomplete, the price covers only the quantity found.</p>
    </section>
  )
}

function minimumQuote(quotes: MarketHubQuote[], kind: 'buy' | 'sell'): MarketHubQuote | null {
  const candidates = quotes.filter((quote) => {
    const fill = kind === 'buy' ? quote.book.immediateBuy : quote.book.immediateSell
    return fill.complete && fill.averagePrice !== null
  })
  return candidates.reduce<MarketHubQuote | null>((best, quote) => {
    if (!best) return quote
    const value = kind === 'buy' ? quote.book.immediateBuy.total : quote.book.immediateSell.total
    const bestValue = kind === 'buy' ? best.book.immediateBuy.total : best.book.immediateSell.total
    return kind === 'buy' ? (value < bestValue ? quote : best) : (value > bestValue ? quote : best)
  }, null)
}

function sparklineGeometry(points: MarketHistoryPoint[], chartId: string): { line: string; area: string; gradientId: string } | null {
  const values = points.map((point) => point.average).filter((value) => Number.isFinite(value) && value >= 0)
  if (values.length === 0) return null
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = maximum - minimum || Math.max(maximum * 0.02, 1)
  const coordinates = values.map((value, index) => {
    const x = values.length === 1 ? 120 : index / (values.length - 1) * 240
    const y = 55 - (value - minimum) / range * 48
    return `${round(x)},${round(y)}`
  })
  const idSeed = `${points[0]?.date ?? 'empty'}-${points.at(-1)?.date ?? 'empty'}-${values.length}`.replace(/[^a-zA-Z0-9-]/g, '')
  return {
    line: coordinates.join(' '),
    area: `0,62 ${coordinates.join(' ')} 240,62`,
    gradientId: `market-area-${chartId}-${idSeed}`
  }
}

function isSearchable(value: string): boolean {
  return value.length >= 3 || /^\d{1,2}$/.test(value)
}

function parseQuantity(value: string): number | null {
  if (!/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2_147_483_647 ? parsed : null
}

function compactStationName(station: string): string {
  return station.length <= 42 ? station : `${station.slice(0, 39)}…`
}

function formatIsk(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000_000_000) return `${trimFixed(value / 1_000_000_000_000)}T ISK`
  if (absolute >= 1_000_000_000) return `${trimFixed(value / 1_000_000_000)}B ISK`
  if (absolute >= 1_000_000) return `${trimFixed(value / 1_000_000)}M ISK`
  if (absolute >= 1_000) return `${trimFixed(value / 1_000)}K ISK`
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} ISK`
}

function trimFixed(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1 }).format(value)
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}%`
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-US')
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
