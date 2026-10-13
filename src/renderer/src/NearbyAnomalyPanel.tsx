import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  NearbyAnomalyRequest,
  NearbyAnomalySnapshot,
  NearbyAnomalySystem
} from '../../shared/nearby-anomalies'
import type { RouteWaypointRequest, RouteWaypointResult } from '../../shared/route-intel'

export interface NearbyAnomalyApi {
  getNearbyAnomalies(request: NearbyAnomalyRequest): Promise<NearbyAnomalySnapshot>
  setRouteWaypoints(request: RouteWaypointRequest): Promise<RouteWaypointResult>
}

export interface NearbyAnomalyPanelProps {
  api: NearbyAnomalyApi | null
  currentSystemId: number | null
  refreshToken?: number
}

export function NearbyAnomalyPanel({
  api,
  currentSystemId,
  refreshToken = 0
}: NearbyAnomalyPanelProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<NearbyAnomalySnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [routingSystemId, setRoutingSystemId] = useState<number | null>(null)
  const [routeNotice, setRouteNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!api || currentSystemId === null) {
      setSnapshot(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await api.getNearbyAnomalies({ originSystemId: currentSystemId, maxJumps: 2 })
      setSnapshot(next)
    } catch (caught) {
      setError(`Could not check saved systems: ${errorMessage(caught)}`)
    } finally {
      setLoading(false)
    }
  }, [api, currentSystemId])

  useEffect(() => {
    void load()
  }, [load, refreshToken, reload])

  const setRoute = useCallback(async (system: NearbyAnomalySystem): Promise<void> => {
    if (!api || system.jumps === 0) return
    setRoutingSystemId(system.solarSystemId)
    setError(null)
    setRouteNotice(null)
    try {
      const destinationIds = system.pathSystemIds.slice(1)
      await api.setRouteWaypoints({ destinationIds })
      setRouteNotice(`Route to ${system.systemName} sent to EVE`)
    } catch (caught) {
      setError(`Could not set route: ${errorMessage(caught)}`)
    } finally {
      setRoutingSystemId(null)
    }
  }, [api])

  return (
    <section className="nearby-anomaly-panel" aria-labelledby="nearby-anomaly-title">
      <div className="nearby-anomaly-heading">
        <div>
          <p className="eyebrow">Probe Scanner · up to 2 jumps</p>
          <h2 id="nearby-anomaly-title">Nearby anomalies</h2>
        </div>
        <button
          type="button"
          className="nearby-anomaly-refresh"
          onClick={() => setReload((value) => value + 1)}
          disabled={!api || currentSystemId === null || loading}
        >
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {currentSystemId === null ? (
        <p className="nearby-anomaly-empty">Connect a character and undock.</p>
      ) : snapshot ? (
        <NearbyAnomalyResults
          snapshot={snapshot}
          routingSystemId={routingSystemId}
          onSetRoute={(system) => void setRoute(system)}
        />
      ) : loading ? (
        <p className="nearby-anomaly-empty">Looking for saved scans within two jumps…</p>
      ) : (
        <p className="nearby-anomaly-empty">
          Copy Probe Scanner results — the system will appear here automatically.
        </p>
      )}

      {routeNotice && <p className="nearby-anomaly-route-notice" role="status">{routeNotice}</p>}
      {error && <p className="nearby-anomaly-error" role="alert">{error}</p>}
      {snapshot?.warnings.map((warning) => (
        <p className="nearby-anomaly-warning" key={warning}>{warning}</p>
      ))}

      <p className="nearby-anomaly-note">
        The count comes only from the last copied Probe Scanner rows, not live data.
        EVE filters and ignored results can hide some sites; systems without a saved scan are not shown.
      </p>
    </section>
  )
}

export function NearbyAnomalyResults({
  snapshot,
  routingSystemId,
  onSetRoute
}: {
  snapshot: NearbyAnomalySnapshot
  routingSystemId: number | null
  onSetRoute: (system: NearbyAnomalySystem) => void
}): React.JSX.Element {
  const reportedSystems = useMemo(() => snapshot.systems.filter((system) => (
    system.observedAt !== null
  )), [snapshot.systems])
  const current = snapshot.systems.find((system) => system.jumps === 0) ?? null
  const nearby = reportedSystems.filter((system) => system.jumps > 0).slice(0, 12)

  return (
    <>
      <div className="nearby-anomaly-summary" aria-label="Saved scan summary">
        <article>
          <span>Current system</span>
          <strong>{current?.systemName ?? `System ${snapshot.originSystemId}`}</strong>
          <small>{current?.anomalyCount == null ? 'no scan yet' : `in scan: ${current.anomalyCount}`}</small>
        </article>
        <article>
          <span>Nearby scanned systems</span>
          <strong>{snapshot.coverage.nearbyReports}</strong>
          <small>within 2 jumps</small>
        </article>
        <article>
          <span>Best saved scan</span>
          <strong>{nearby.length > 0 ? Math.max(...nearby.map((system) => system.anomalyCount ?? 0)) : '—'}</strong>
          <small>visible anomalies</small>
        </article>
      </div>

      {nearby.length > 0 ? (
        <div className="nearby-anomaly-list">
          {nearby.map((system) => (
            <article
              className={`nearby-anomaly-card ${system.freshness}`}
              key={system.solarSystemId}
            >
              <div className="nearby-anomaly-system">
                <div>
                  <strong>{system.systemName}</strong>
                  <span>{jumpLabel(system.jumps)} · {securityLabel(system.securityStatus)}</span>
                </div>
                <div className="nearby-anomaly-count">
                  <strong>{system.anomalyCount}</strong>
                  <span>visible in scan</span>
                </div>
              </div>
              <div className="nearby-anomaly-meta">
                <span className={`nearby-anomaly-freshness ${system.freshness}`}>
                  {freshnessLabel(system)}
                </span>
                {system.signatureCount !== null && <span>signatures: {system.signatureCount}</span>}
              </div>
              {system.sites.length > 0 && (
                <div className="nearby-anomaly-sites">
                  {system.sites.slice(0, 4).map((site) => (
                    <span key={site.name}>{site.name}{site.count > 1 ? ` ×${site.count}` : ''}</span>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="nearby-anomaly-route"
                onClick={() => onSetRoute(system)}
                disabled={routingSystemId !== null}
              >
                {routingSystemId === system.solarSystemId ? 'Sending…' : 'Route in EVE'}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <p className="nearby-anomaly-empty">
          No saved Probe Scanner results yet from systems within two jumps.
        </p>
      )}
    </>
  )
}

function freshnessLabel(system: NearbyAnomalySystem): string {
  if (system.ageMinutes === null) return 'no scan'
  const age = formatAge(system.ageMinutes)
  if (system.freshness === 'fresh') return `fresh · ${age}`
  if (system.freshness === 'recent') return `recent · ${age}`
  return `stale · ${age}`
}

function formatAge(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${Math.floor(minutes)} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

function securityLabel(value: number | null): string {
  return value === null ? 'security —' : `security ${value.toFixed(1)}`
}

function jumpLabel(jumps: number): string {
  return jumps === 1 ? '1 jump' : `${jumps} jumps`
}

function errorMessage(value: unknown): string {
  return value instanceof Error && value.message ? value.message : 'unknown error'
}
