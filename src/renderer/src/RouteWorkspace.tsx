import { useEffect, useMemo, useState } from 'react'
import type {
  RouteIntelRequest,
  RouteIntelResult,
  RouteMode,
  RouteSystemIntel,
  RouteWaypointRequest,
  RouteWaypointResult
} from '../../shared/route-intel'

interface RouteApi {
  getRouteIntel(request: RouteIntelRequest): Promise<RouteIntelResult>
  setRouteWaypoints?(request: RouteWaypointRequest): Promise<RouteWaypointResult>
}

export function RouteWorkspace({
  api,
  active,
  currentSystemId,
  currentSystemName,
  onResultChange
}: {
  api: RouteApi | null
  active: boolean
  currentSystemId: number | null
  currentSystemName: string | null
  onResultChange?: (result: RouteIntelResult) => void
}): React.JSX.Element {
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [mode, setMode] = useState<RouteMode>('secure')
  const [includeHauling, setIncludeHauling] = useState(false)
  const [marketDelta, setMarketDelta] = useState('')
  const [cargoM3, setCargoM3] = useState('')
  const [feePercent, setFeePercent] = useState('')
  const [feeBasis, setFeeBasis] = useState('')
  const [fixedCosts, setFixedCosts] = useState('')
  const [result, setResult] = useState<RouteIntelResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [waypointLoading, setWaypointLoading] = useState<'route' | 'destination' | null>(null)
  const [waypointMessage, setWaypointMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (active && !origin && currentSystemName) setOrigin(currentSystemName)
  }, [active, currentSystemName, origin])

  const canSubmit = origin.trim().length > 0 && destination.trim().length > 0 && !loading
  const highestRisk = useMemo(() => result
    ? result.systems.find((system) => system.systemId === result.summary.highestRiskSystemId) ?? null
    : null, [result])

  const submit = async (forceRefresh = false): Promise<void> => {
    if (!api || !canSubmit) return
    setLoading(true)
    setError(null)
    try {
      const request: RouteIntelRequest = {
        origin: origin.trim(),
        destination: destination.trim(),
        mode,
        forceRefresh,
        includeRecentPublicKillmails: true
      }
      if (includeHauling) {
        const parsedDelta = parseNumber(marketDelta)
        const parsedVolume = parseNumber(cargoM3)
        const parsedFeePercent = parseNumber(feePercent) ?? 0
        const parsedFeeBasis = parseNumber(feeBasis) ?? 0
        const parsedFixed = parseNumber(fixedCosts) ?? 0
        if (parsedDelta === null || parsedVolume === null || parsedVolume <= 0) {
          throw new TypeError('For hauling, enter a market difference and positive cargo volume')
        }
        request.hauling = {
          marketDeltaIsk: parsedDelta,
          cargoM3: parsedVolume,
          fees: {
            rate: parsedFeePercent / 100,
            basisIsk: parsedFeeBasis,
            fixedIsk: parsedFixed
          }
        }
      }
      const nextResult = await api.getRouteIntel(request)
      setResult(nextResult)
      onResultChange?.(nextResult)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
    }
  }

  const installWaypoints = async (wholeRoute: boolean): Promise<void> => {
    if (!api?.setRouteWaypoints || !result || waypointLoading) return
    let destinationIds: number[]
    if (wholeRoute) {
      const currentIndex = currentSystemId === null
        ? -1
        : result.systems.findIndex((system) => system.systemId === currentSystemId)
      if (currentIndex < 0) {
        setError('Your current system is not on the calculated route. Recalculate from your current position.')
        return
      }
      destinationIds = result.systems.slice(currentIndex + 1).map((system) => system.systemId)
      if (destinationIds.length === 0) {
        setWaypointMessage('You are already in the route destination system.')
        return
      }
    } else {
      destinationIds = [result.request.destination.id]
    }
    if (destinationIds.length === 0) return
    setWaypointLoading(wholeRoute ? 'route' : 'destination')
    setWaypointMessage(null)
    setError(null)
    try {
      const installed = await api.setRouteWaypoints({ destinationIds })
      setWaypointMessage(
        wholeRoute
          ? `Route set in EVE: ${installed.waypointsSet} waypoints`
          : 'Destination set in EVE autopilot'
      )
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setWaypointLoading(null)
    }
  }

  return (
    <section className="route-shell" aria-labelledby="route-title">
      <div className="workspace-hero route-hero">
        <div>
          <p className="eyebrow">Route planner · Camp Radar</p>
          <h1 id="route-title">Route and dangerous systems</h1>
          <p>Public aggregates of losses, jumps, and killmails. This is a warning, not a live radar.</p>
        </div>
      </div>

      <section className="route-builder">
        <div className="route-endpoints">
          <label>
            <span>From</span>
            <input value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="Jita" />
          </label>
          <button
            type="button"
            className="route-swap"
            onClick={() => { setOrigin(destination); setDestination(origin) }}
            aria-label="Swap systems"
          >⇄</button>
          <label>
            <span>To</span>
            <input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Amarr" />
          </label>
          <label className="route-mode">
            <span>Mode</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as RouteMode)}>
              <option value="secure">Safer</option>
              <option value="shortest">Faster</option>
              <option value="insecure">Riskier</option>
            </select>
          </label>
        </div>
        <div className="route-builder-actions">
          {currentSystemName && (
            <button type="button" className="text-button" onClick={() => setOrigin(currentSystemName)}>
              Start from current: {currentSystemName}
            </button>
          )}
          <label className="route-hauling-toggle">
            <input type="checkbox" checked={includeHauling} onChange={(event) => setIncludeHauling(event.target.checked)} />
            Calculate hauling
          </label>
          <button type="button" className="primary-button" disabled={!api || !canSubmit} onClick={() => void submit()}>
            {loading ? 'Building…' : 'Build route'}
          </button>
        </div>

        {includeHauling && (
          <div className="hauling-inputs">
            <NumberField label="Market difference, ISK" value={marketDelta} onChange={setMarketDelta} />
            <NumberField label="Volume, m³" value={cargoM3} onChange={setCargoM3} />
            <NumberField label="Fee, %" value={feePercent} onChange={setFeePercent} />
            <NumberField label="Fee basis, ISK" value={feeBasis} onChange={setFeeBasis} />
            <NumberField label="Other costs, ISK" value={fixedCosts} onChange={setFixedCosts} />
          </div>
        )}
      </section>

      {error && <div className="workspace-inline-error" role="alert">{error}</div>}

      {result && (
        <>
          <div className="route-summary-grid">
            <RouteMetric label="Jumps" value={String(result.summary.jumps)} />
            <RouteMetric label="Average risk" value={`${result.summary.averageRiskScore}/100`} tone={riskTone(result.summary.averageRiskScore)} />
            <RouteMetric label="Dangerous systems" value={String(result.summary.highRiskSystems)} tone={result.summary.highRiskSystems > 0 ? 'danger' : 'safe'} />
            <RouteMetric label="Camp patterns" value={String(result.summary.campPatternSystems)} tone={result.summary.campPatternSystems > 0 ? 'warning' : 'safe'} />
            <RouteMetric label="Recent fights" value={String(result.summary.freshKillmailSystems)} detail={`Checked ${result.summary.recentIntelSystemsChecked}`} tone={result.summary.hotKillmailSystems > 0 ? 'danger' : result.summary.freshKillmailSystems > 0 ? 'warning' : 'safe'} />
            <RouteMetric label="Most dangerous" value={highestRisk?.name ?? '—'} detail={highestRisk ? `${highestRisk.risk.score}/100` : undefined} tone={highestRisk ? riskTone(highestRisk.risk.score) : 'neutral'} />
          </div>

          {result.corridorAlerts.length > 0 && (
            <section className="route-corridor-alerts" aria-label="Recent killmails on route">
              <div className="route-alert-heading">
                <div>
                  <p className="eyebrow">Corridor alert · public killmail</p>
                  <h2>Recent fights ahead</h2>
                </div>
                <span>{result.corridorAlerts.length}</span>
              </div>
              <div className="route-alert-list">
                {result.corridorAlerts.slice(0, 8).map((alert) => (
                  <article className={`route-alert route-alert-${alert.severity}`} key={`${alert.systemId}-${alert.latestAt}`}>
                    <strong>{alert.systemName ?? alert.systemId}</strong>
                    <span>{alert.lastHourCount > 0
                      ? `${alert.lastHourCountLowerBound ? '≥' : ''}${alert.lastHourCount} per hour`
                      : 'fight in the last 6 h'}</span>
                    <b>{formatAge(alert.ageMinutes)} ago</b>
                    <small>{alert.systemIndex} jumps away</small>
                  </article>
                ))}
              </div>
              <p>This is the public killmail time, not confirmation that the camp is still present.</p>
            </section>
          )}

          {result.hauling && (
            <section className={`route-hauling-result ${result.hauling.profitable ? 'positive' : 'negative'}`}>
              <div><span>Net profit</span><strong>{signedIsk(result.hauling.netProfitIsk)}</strong></div>
              <div><span>Per m³</span><strong>{signedIsk(result.hauling.netProfitPerM3)}</strong></div>
              <div><span>Per jump</span><strong>{result.hauling.netProfitPerJump === null ? '—' : signedIsk(result.hauling.netProfitPerJump)}</strong></div>
              <div><span>Costs</span><strong>{formatIsk(result.hauling.totalCostsIsk)}</strong></div>
            </section>
          )}

          <section className="route-path-panel">
            <div className="section-heading compact">
              <div><p className="eyebrow">{result.request.origin.name ?? origin} → {result.request.destination.name ?? destination}</p><h2>Route systems</h2></div>
              <div className="route-path-actions">
                {api?.setRouteWaypoints && (
                  <>
                    <button type="button" className="secondary-button" disabled={waypointLoading !== null} onClick={() => void installWaypoints(false)}>
                      {waypointLoading === 'destination' ? 'Setting…' : 'Destination in EVE'}
                    </button>
                    <button type="button" className="primary-button" disabled={waypointLoading !== null} onClick={() => void installWaypoints(true)}>
                      {waypointLoading === 'route' ? 'Setting…' : 'Full route in EVE'}
                    </button>
                  </>
                )}
                <button type="button" className="secondary-button" disabled={loading} onClick={() => void submit(true)}>Refresh data</button>
              </div>
            </div>
            {waypointMessage && <div className="route-waypoint-success" role="status">{waypointMessage}</div>}
            <div className="route-system-list">
              {result.systems.map((system) => <RouteSystemCard key={`${system.systemId}-${system.index}`} system={system} />)}
            </div>
            <p className="data-boundary-note">
              Fly Safe cannot see live campers. Camp Radar marks only historical patterns from
              available public sources; always check the time and confidence.
            </p>
          </section>

          {result.warnings.length > 0 && <div className="workspace-warning-list">{result.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
          <p className="workspace-updated">Checked: {formatDate(result.evaluatedAt)} · confidence {result.confidence}</p>
        </>
      )}
    </section>
  )
}

function RouteSystemCard({ system }: { system: RouteSystemIntel }): React.JSX.Element {
  return (
    <article className={`route-system risk-${system.risk.level}`}>
      <div className="route-system-index">{system.index + 1}</div>
      <div className="route-system-name">
        <strong>{system.name ?? system.systemId}</strong>
        <small>SEC {system.securityStatus === null ? '—' : system.securityStatus.toFixed(2)} · {system.risk.confidence}</small>
      </div>
      <div className="route-system-activity"><span>Ships</span><b>{system.activity.shipKills ?? '—'}</b></div>
      <div className="route-system-activity"><span>Pods</span><b>{system.activity.podKills ?? '—'}</b></div>
      <div className="route-system-activity"><span>Jumps</span><b>{system.activity.jumps ?? '—'}</b></div>
      <div className={`route-system-activity route-killmail-${system.activity.killmailFreshness}`}>
        <span>Killmail</span>
        <b>{system.activity.recentPublicKillmails ?? '—'}</b>
        <small>{killmailFreshnessLabel(system)}</small>
      </div>
      <div className="route-risk-score"><strong>{system.risk.score}</strong><small>/ 100</small></div>
      <div className={`route-camp camp-${system.risk.campPattern}`}>
        {system.risk.campPattern === 'strong' ? 'STRONG CAMP PATTERN' : system.risk.campPattern === 'possible' ? 'POSSIBLE CAMP' : 'no camp pattern'}
      </div>
      {system.risk.factors.length > 0 && (
        <div className="route-risk-reasons">{system.risk.factors.slice(0, 4).map((factor) => <span key={factor.code}>{factor.reason} (+{factor.points})</span>)}</div>
      )}
    </article>
  )
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }): React.JSX.Element {
  return <label><span>{label}</span><input inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} placeholder="0" /></label>
}

function RouteMetric({ label, value, detail, tone = 'neutral' }: { label: string; value: string; detail?: string; tone?: string }): React.JSX.Element {
  return <article className={`route-metric ${tone}`}><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</article>
}

function riskTone(score: number): string {
  if (score >= 75) return 'danger'
  if (score >= 50) return 'warning'
  if (score >= 25) return 'guarded'
  return 'safe'
}

function parseNumber(value: string): number | null {
  const normalized = value.trim().replace(/\s+/g, '').replace(',', '.')
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function formatIsk(value: number): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)} ISK`
}

function signedIsk(value: number): string {
  return `${value >= 0 ? '+' : '−'}${formatIsk(Math.abs(value))}`
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' }).format(Date.parse(value))
}

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function killmailFreshnessLabel(system: RouteSystemIntel): string {
  const age = system.activity.latestPublicKillmailAgeMinutes
  if (!system.activity.recentIntelChecked) return 'not checked'
  if (system.activity.killmailFreshness === 'none') return 'none in 24 h'
  if (age === null) return 'time unknown'
  return `${formatAge(age)} ago`
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error'
}
