import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  NearbyPveRequest,
  NearbyPveSnapshot,
  NearbyPveSystem
} from '../../shared/nearby-pve'
import type { RouteWaypointRequest, RouteWaypointResult } from '../../shared/route-intel'

export interface NearbyPveApi {
  getNearbyPve(request: NearbyPveRequest): Promise<NearbyPveSnapshot>
  setRouteWaypoints(request: RouteWaypointRequest): Promise<RouteWaypointResult>
}

export function NearbyPvePanel({
  api,
  currentSystemId
}: {
  api: NearbyPveApi | null
  currentSystemId: number | null
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<NearbyPveSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [routingSystemId, setRoutingSystemId] = useState<number | null>(null)
  const [routeNotice, setRouteNotice] = useState<string | null>(null)
  const requestSequenceRef = useRef(0)

  useEffect(() => {
    requestSequenceRef.current += 1
    const sequence = requestSequenceRef.current
    setRouteNotice(null)
    if (!api || currentSystemId === null) {
      setSnapshot(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    void api.getNearbyPve({ originSystemId: currentSystemId, maxJumps: 2 })
      .then((next) => {
        if (requestSequenceRef.current === sequence) setSnapshot(next)
      })
      .catch((caught) => {
        if (requestSequenceRef.current === sequence) {
          setError(`Could not get nearby systems: ${errorMessage(caught)}`)
        }
      })
      .finally(() => {
        if (requestSequenceRef.current === sequence) setLoading(false)
      })
  }, [api, currentSystemId, reload])

  const setRoute = async (system: NearbyPveSystem): Promise<void> => {
    if (!api || system.jumps === 0) return
    setRoutingSystemId(system.solarSystemId)
    setError(null)
    setRouteNotice(null)
    try {
      await api.setRouteWaypoints({ destinationIds: system.pathSystemIds.slice(1) })
      setRouteNotice(`Route to ${system.systemName} sent to EVE`)
    } catch (caught) {
      setError(`Could not set route: ${errorMessage(caught)}`)
    } finally {
      setRoutingSystemId(null)
    }
  }

  return (
    <section className="nearby-anomaly-panel" aria-labelledby="nearby-pve-title">
      <div className="nearby-anomaly-heading">
        <div>
          <p className="eyebrow">Public ESI statistics · up to 2 jumps</p>
          <h2 id="nearby-pve-title">Nearby PvE</h2>
        </div>
        <button
          type="button"
          className="nearby-anomaly-refresh"
          onClick={() => setReload((value) => value + 1)}
          disabled={!api || currentSystemId === null || loading}
        >
          {loading ? 'Finding systems…' : 'Refresh'}
        </button>
      </div>

      {currentSystemId === null ? (
        <p className="nearby-anomaly-empty">Connect a character and undock.</p>
      ) : snapshot ? (
        <NearbyPveResults
          snapshot={snapshot}
          routingSystemId={routingSystemId}
          onSetRoute={(system) => void setRoute(system)}
        />
      ) : loading ? (
        <p className="nearby-anomaly-empty">Building a stargate map up to two jumps away…</p>
      ) : null}

      {routeNotice && <p className="nearby-anomaly-route-notice" role="status">{routeNotice}</p>}
      {error && <p className="nearby-anomaly-error" role="alert">{error}</p>}
      {snapshot?.warnings.map((warning) => (
        <p className="nearby-anomaly-warning" key={warning}>{warning}</p>
      ))}
      <p className="nearby-anomaly-note">
        ESI does not show the number or types of anomalies. NPCs destroyed indicate recent
        PvE activity, not the number of free sites; high activity may mean ratters are already there.
      </p>
    </section>
  )
}

export function NearbyPveResults({
  snapshot,
  routingSystemId,
  onSetRoute
}: {
  snapshot: NearbyPveSnapshot
  routingSystemId: number | null
  onSetRoute: (system: NearbyPveSystem) => void
}): React.JSX.Element {
  const current = snapshot.systems.find((system) => system.jumps === 0) ?? null
  const nearby = useMemo(
    () => snapshot.systems.filter((system) => system.jumps > 0),
    [snapshot.systems]
  )
  const leader = nearby.find((system) => system.npcKills !== null) ?? null

  return (
    <>
      <div className="nearby-anomaly-summary" aria-label="Nearby PvE-system summary">
        <article>
          <span>Current system</span>
          <strong>{current?.systemName ?? `System ${snapshot.originSystemId}`}</strong>
          <small>starting point</small>
        </article>
        <article>
          <span>Systems found</span>
          <strong>{nearby.length}</strong>
          <small>within 2 jumps</small>
        </article>
        <article>
          <span>Top NPCs / 1 h</span>
          <strong>{leader?.npcKills ?? '—'}</strong>
          <small>{leader?.systemName ?? 'no data'}</small>
        </article>
      </div>

      {nearby.length > 0 ? (
        <div className="nearby-anomaly-list nearby-pve-list">
          {nearby.map((system) => (
            <article className={`nearby-anomaly-card pve-${system.activity}`} key={system.solarSystemId}>
              <div className="nearby-anomaly-system">
                <div>
                  <strong>{system.systemName}</strong>
                  <span>{jumpLabel(system.jumps)} · security {formatSecurity(system.securityStatus)}</span>
                </div>
                <div className="nearby-anomaly-count">
                  <strong>{system.npcKills ?? '—'}</strong>
                  <span>NPCs in 1 h</span>
                </div>
              </div>
              <div className="nearby-pve-metrics">
                <span>Jumps <b>{system.shipJumps ?? '—'}</b></span>
                <span>Ships lost <b>{system.shipKills ?? '—'}</b></span>
                <span>Pods <b>{system.podKills ?? '—'}</b></span>
              </div>
              <div className="nearby-anomaly-meta">
                <span className={`nearby-pve-activity ${system.activity}`}>
                  {activityLabel(system.activity)}
                </span>
                <span>{system.jumps === 1 ? 'neighboring system' : 'two systems away'}</span>
              </div>
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
          No stargate neighbors found. Use Chain Mapper for wormhole systems.
        </p>
      )}
    </>
  )
}

function activityLabel(value: NearbyPveSystem['activity']): string {
  if (value === 'very-high') return 'very high PvE activity'
  if (value === 'high') return 'high PvE activity'
  if (value === 'medium') return 'noticeable PvE activity'
  if (value === 'low') return 'low PvE activity'
  if (value === 'quiet') return 'no NPC activity recorded'
  return 'activity data unavailable'
}

function formatSecurity(value: number): string {
  if (value > 0 && value < 0.05) return '0.1'
  return value.toFixed(1)
}

function jumpLabel(jumps: number): string {
  return jumps === 1 ? '1 jump' : `${jumps} jumps`
}

function errorMessage(value: unknown): string {
  return value instanceof Error && value.message ? value.message : 'unknown error'
}
