import { useMemo, useState } from 'react'
import {
  type DscanRow,
  type ProbeRow
} from '../../shared/clipboard-intel'
import type {
  DscanAlert,
  DscanDangerousRole,
  DscanHullComposition,
  DscanIntelligence
} from '../../shared/dscan-intelligence'
import { EveTypeImage } from './EveTypeImage'

export interface ProbeScanChanges {
  comparable: boolean
  added: string[]
  removed: string[]
  changed: string[]
}

export type TacticalClipboardSnapshot =
  | {
      kind: 'dscan'
      capturedAt: string
      /** System at capture time; null means the ESI position was unavailable. */
      solarSystemId: number | null
      rows: DscanRow[]
      rejected: number
      intelligence: DscanIntelligence
      enrichmentPending?: boolean
      enrichmentWarning?: string
    }
  | {
      kind: 'probe'
      capturedAt: string
      /** Authenticated ESI position used when this clipboard snapshot was captured. */
      solarSystemId: number | null
      systemName: string | null
      rows: ProbeRow[]
      rejected: number
      changes: ProbeScanChanges
    }

const DSCAN_ROLE_COPY: Record<DscanDangerousRole, {
  label: string
  detail: string
  tone: 'critical' | 'danger' | 'warning' | 'info'
}> = {
  capital: {
    label: 'Capitals on D-scan',
    detail: 'Check range, cynos, and support.',
    tone: 'critical'
  },
  tackle: {
    label: 'Tackle / dictors',
    detail: 'Ships able to hold you down or launch a bubble are present.',
    tone: 'danger'
  },
  logistics: {
    label: 'Logistics',
    detail: 'The enemy may have active repairs.',
    tone: 'warning'
  },
  recon: {
    label: 'Recon ships',
    detail: 'Cynos, webs, neuts, or long-range tackle are possible.',
    tone: 'danger'
  },
  ewar: {
    label: 'EWAR',
    detail: 'Expect jams, damps, tracking disruption, or paints.',
    tone: 'warning'
  },
  command: {
    label: 'Command ships',
    detail: 'Boosts and a stronger fleet composition are possible.',
    tone: 'info'
  }
}

function formatCapturedAt(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(timestamp))
}

function hullLabel(hull: Pick<DscanHullComposition, 'typeName' | 'typeId'>): string {
  return hull.typeName ?? (hull.typeId ? `Type ID ${hull.typeId}` : 'Unknown type')
}

function alertCopy(alert: DscanAlert): {
  label: string
  detail: string
  tone: 'critical' | 'danger' | 'warning' | 'info'
} {
  if (alert.kind === 'combat-scanner-probes') {
    return {
      label: 'Combat Scanner Probes',
      detail: 'Combat Scanner Probes on D-scan: your position may be getting scanned.',
      tone: 'critical'
    }
  }
  return DSCAN_ROLE_COPY[alert.role]
}

function DscanResults({ snapshot }: {
  snapshot: Extract<TacticalClipboardSnapshot, { kind: 'dscan' }>
}): React.JSX.Element {
  const [showRawRows, setShowRawRows] = useState(false)
  const [showAllRows, setShowAllRows] = useState(false)
  const [showAllComposition, setShowAllComposition] = useState(false)
  const { composition, changes, alerts } = snapshot.intelligence
  const addedKeys = useMemo(
    () => new Set(changes.added.map((hull) => hull.key)),
    [changes.added]
  )
  const orderedAlerts = useMemo(
    () => [...alerts].sort((left, right) => {
      if (left.kind === right.kind) return right.addedCount - left.addedCount
      return left.kind === 'combat-scanner-probes' ? -1 : 1
    }),
    [alerts]
  )
  const visibleComposition = showAllComposition
    ? composition.hulls
    : composition.hulls.slice(0, 12)
  const sortedRows = useMemo(
    () => [...snapshot.rows].sort((left, right) => {
      const leftDistance = left.distance?.meters ?? Number.POSITIVE_INFINITY
      const rightDistance = right.distance?.meters ?? Number.POSITIVE_INFINITY
      return leftDistance - rightDistance || left.type.localeCompare(right.type)
    }),
    [snapshot.rows]
  )
  const visibleRows = showAllRows ? sortedRows : sortedRows.slice(0, 18)

  const customNamesForHull = (hull: DscanHullComposition): string[] => {
    const names = snapshot.rows.flatMap((row) => {
      const sameHull = hull.typeId !== null
        ? row.typeId === hull.typeId
        : row.typeId === null && row.type.trim().toLocaleLowerCase('en-US') === hull.normalizedType
      const nativeTypePending = row.typeId !== null &&
        row.name.trim().toLocaleLowerCase('en-US') === row.type.trim().toLocaleLowerCase('en-US')
      if (!sameHull || (!nativeTypePending && row.name.trim().toLocaleLowerCase('en-US') === row.type.trim().toLocaleLowerCase('en-US'))) {
        return []
      }
      return [row.name.trim()]
    })
    return [...new Set(names)]
  }

  return (
    <section className="clipboard-intel-panel dscan-panel" aria-labelledby="dscan-result-title">
      <div className="clipboard-intel-heading">
        <div>
          <p className="eyebrow">EVE clipboard · Directional Scanner</p>
          <h2 id="dscan-result-title">D-scan composition</h2>
        </div>
        <div className="clipboard-capture-stamp">
          <strong>{snapshot.rows.length}</strong>
          <span>{formatCapturedAt(snapshot.capturedAt)}</span>
        </div>
      </div>

      <div className="clipboard-metric-grid">
        <article>
          <span>Objects</span>
          <strong>{snapshot.rows.length}</strong>
          <small>rows at capture time</small>
        </article>
        <article>
          <span>Types</span>
          <strong>{composition.hulls.length}</strong>
          <small>grouped composition</small>
        </article>
        <article className={changes.addedCount > 0 ? 'warning' : ''}>
          <span>Appeared</span>
          <strong>{changes.hasBaseline ? `+${changes.addedCount}` : '—'}</strong>
          <small>{changes.hasBaseline ? 'since the last D-scan' : 'a second snapshot is needed'}</small>
        </article>
        <article className={changes.removedCount > 0 ? 'info' : ''}>
          <span>Disappeared</span>
          <strong>{changes.hasBaseline ? `−${changes.removedCount}` : '—'}</strong>
          <small>{changes.hasBaseline ? 'since the last D-scan' : 'a second snapshot is needed'}</small>
        </article>
      </div>

      {changes.hasBaseline ? (
        <div className="dscan-change-strip" aria-label="Changes since the previous D-scan">
          <div className="dscan-change-summary">
            <span className="added">+{changes.addedCount} appeared</span>
            <span className="removed">−{changes.removedCount} disappeared</span>
            <span className={changes.netCount > 0 ? 'added' : changes.netCount < 0 ? 'removed' : ''}>
              Net {changes.netCount > 0 ? '+' : ''}{changes.netCount}
            </span>
          </div>
          <div className="dscan-change-types">
            {changes.added.map((hull) => (
              <span key={`added:${hull.key}`} className="added">
                +{hull.delta} {hullLabel(hull)}
              </span>
            ))}
            {changes.removed.map((hull) => (
              <span key={`removed:${hull.key}`} className="removed">
                −{Math.abs(hull.delta)} {hullLabel(hull)}
              </span>
            ))}
            {changes.added.length === 0 && changes.removed.length === 0 && (
              <span className="unchanged">Composition unchanged</span>
            )}
          </div>
        </div>
      ) : (
        <p className="dscan-baseline-note">First snapshot saved. The next D-scan will show what appeared and disappeared.</p>
      )}

      {orderedAlerts.length > 0 ? (
        <section className="dscan-alert-section" aria-labelledby="dscan-alert-title">
          <div className="dscan-subheading">
            <div>
              <p className="eyebrow">Priority signals</p>
              <h3 id="dscan-alert-title">Needs attention</h3>
            </div>
            <span>{orderedAlerts.length}</span>
          </div>
          <div className="dscan-alert-grid">
            {orderedAlerts.map((alert) => {
              const copy = alertCopy(alert)
              const alertKey = alert.kind === 'role' ? alert.role : alert.kind
              return (
                <article
                  key={alertKey}
                  className={`dscan-alert-card tone-${copy.tone} ${alert.addedCount > 0 ? 'is-new' : ''}`}
                >
                  <div className="dscan-alert-title">
                    <strong>{copy.label}</strong>
                    <b>{alert.count}</b>
                  </div>
                  {alert.addedCount > 0 && <span className="dscan-new-badge">+{alert.addedCount} new</span>}
                  <p>{copy.detail}</p>
                  <small>{alert.hulls.map((hull) => `${hull.typeName ?? `ID ${hull.typeId}`} ×${hull.count}`).join(' · ')}</small>
                </article>
              )
            })}
          </div>
        </section>
      ) : (
        <div className="dscan-clear-state">
          <strong>No priority threats detected</strong>
          <span>The snapshot contains no known combat probes, tackle, logistics, capitals, recon ships, EWAR, or command ships.</span>
        </div>
      )}

      <section className="dscan-composition-section" aria-labelledby="dscan-composition-title">
        <div className="dscan-subheading">
          <div>
            <p className="eyebrow">Composition by type</p>
            <h3 id="dscan-composition-title">What is on D-scan</h3>
          </div>
          <span>{composition.hulls.length}</span>
        </div>
        <div className="dscan-composition-grid">
          {visibleComposition.map((hull) => {
            const customNames = customNamesForHull(hull)
            const unresolvedNativeType = hull.typeId !== null && snapshot.rows.some((row) => (
              row.typeId === hull.typeId &&
              row.type.trim().toLocaleLowerCase('en-US') === row.name.trim().toLocaleLowerCase('en-US')
            ))
            const displayLabel = unresolvedNativeType ? `Type ID ${hull.typeId}` : hullLabel(hull)
            return (
              <article
                key={hull.key}
                className={`dscan-hull-card ${addedKeys.has(hull.key) ? 'is-new' : ''}`}
              >
                {hull.typeId ? (
                  <EveTypeImage
                    typeId={hull.typeId}
                    variant="icon"
                    requestSize={64}
                    className="dscan-hull-image"
                  />
                ) : (
                  <span className="dscan-hull-image dscan-hull-fallback" aria-hidden="true">◇</span>
                )}
                <div className="dscan-hull-copy">
                  <strong title={displayLabel}>{displayLabel}</strong>
                  {customNames.length > 0 ? (
                    <small title={customNames.join(', ')}>
                      {customNames[0]}{customNames.length > 1 ? ` +${customNames.length - 1}` : ''}
                    </small>
                  ) : (
                    <small>{hull.roles.map((role) => DSCAN_ROLE_COPY[role].label).join(' · ') || 'D-scan object'}</small>
                  )}
                </div>
                <b className="dscan-hull-count">×{hull.count}</b>
                {addedKeys.has(hull.key) && <span className="dscan-hull-new">NEW</span>}
              </article>
            )
          })}
        </div>
        {composition.hulls.length > 12 && (
          <button
            type="button"
            className="clipboard-show-all"
            aria-expanded={showAllComposition}
            onClick={() => setShowAllComposition((current) => !current)}
          >
            {showAllComposition ? 'Collapse composition' : `Show all composition (${composition.hulls.length})`}
          </button>
        )}
      </section>

      <div className="dscan-raw-section">
        <button
          type="button"
          className="dscan-raw-toggle"
          aria-expanded={showRawRows}
          aria-controls="dscan-raw-rows"
          onClick={() => setShowRawRows((current) => !current)}
        >
          <span>{showRawRows ? 'Hide source rows' : 'Show source rows'}</span>
          <b>{snapshot.rows.length}</b>
        </button>

        {showRawRows && (
          <div id="dscan-raw-rows">
            <div className="clipboard-table-wrap">
              <table className="clipboard-result-table">
                <thead>
                  <tr>
                    <th>Object name</th>
                    <th>Official type</th>
                    <th>Distance</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((row, index) => (
                    <tr key={`${row.lineNumber}:${row.name}:${index}`}>
                      <td title={row.name}>{row.name}</td>
                      <td title={row.type}>
                        {row.typeId !== null && row.type === row.name
                          ? snapshot.enrichmentPending
                            ? 'Resolving type…'
                            : `Type ID ${row.typeId}`
                          : row.type}
                      </td>
                      <td>{row.distanceText || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {sortedRows.length > 18 && (
              <button
                type="button"
                className="clipboard-show-all"
                aria-expanded={showAllRows}
                onClick={() => setShowAllRows((current) => !current)}
              >
                {showAllRows ? 'Collapse rows' : `Show all rows (${sortedRows.length})`}
              </button>
            )}
          </div>
        )}
      </div>

      <p className="clipboard-intel-note">
        Snapshot of a single manual D-scan. Pilots, cloaked ships, and objects outside range cannot be identified.
        Roles are detected from the exact English hull name.
        {snapshot.enrichmentPending && ' Resolving official type names in the background…'}
        {snapshot.enrichmentWarning && ` ${snapshot.enrichmentWarning}`}
        {snapshot.rejected > 0 && ` Rows skipped: ${snapshot.rejected}.`}
      </p>
    </section>
  )
}

function ProbeResults({ snapshot }: { snapshot: Extract<TacticalClipboardSnapshot, { kind: 'probe' }> }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const signatures = snapshot.rows.filter((row) => row.kind === 'signature')
  const anomalies = snapshot.rows.filter((row) => row.kind === 'anomaly')
  const resolved = snapshot.rows.filter((row) => row.signal === 100)
  const wormholes = snapshot.rows.filter((row) =>
    `${row.type ?? ''} ${row.name ?? ''}`.toLocaleLowerCase('en-US').match(/wormhole|червоточ|кротов/)
  )
  const sortedRows = [...snapshot.rows].sort((left, right) => left.id.localeCompare(right.id))
  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, 18)

  return (
    <section className="clipboard-intel-panel probe-panel" aria-labelledby="probe-result-title">
      <div className="clipboard-intel-heading">
        <div>
          <p className="eyebrow">EVE clipboard · Probe Scanner signatures</p>
          <h2 id="probe-result-title">Signatures and anomalies</h2>
          <small className="probe-captured-system">
            {snapshot.systemName ?? (snapshot.solarSystemId ? `System ${snapshot.solarSystemId}` : 'System not identified')}
          </small>
        </div>
        <div className="clipboard-capture-stamp">
          <strong>{snapshot.rows.length}</strong>
          <span>{formatCapturedAt(snapshot.capturedAt)}</span>
        </div>
      </div>

      <div className="clipboard-metric-grid">
        <article><span>Signatures</span><strong>{signatures.length}</strong><small>cosmic signatures</small></article>
        <article><span>Anomalies</span><strong>{anomalies.length}</strong><small>cosmic anomalies</small></article>
        <article className={wormholes.length > 0 ? 'info' : ''}><span>Wormhole</span><strong>{wormholes.length}</strong><small>identified type/name</small></article>
        <article><span>100% signal</span><strong>{resolved.length}</strong><small>fully scanned</small></article>
      </div>

      {snapshot.changes.comparable && (
        <div className="probe-change-strip" aria-label="Changes since the previous signature list">
          <span className="added">New <b>{snapshot.changes.added.length}</b></span>
          <span className="removed">Gone <b>{snapshot.changes.removed.length}</b></span>
          <span className="changed">Changed <b>{snapshot.changes.changed.length}</b></span>
          {snapshot.changes.added.length > 0 && <small>+ {snapshot.changes.added.join(', ')}</small>}
          {snapshot.changes.removed.length > 0 && <small>− {snapshot.changes.removed.join(', ')}</small>}
        </div>
      )}

      <div className="clipboard-table-wrap">
        <table className="clipboard-result-table probe-result-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Group</th>
              <th>Type / name</th>
              <th>Signal</th>
              <th>Distance</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={`${row.id}:${row.lineNumber}`}>
                <td><b>{row.id}</b></td>
                <td>{row.group}</td>
                <td title={[row.type, row.name].filter(Boolean).join(' · ')}>
                  {[row.type, row.name].filter(Boolean).join(' · ') || 'Not identified'}
                </td>
                <td>{row.signalText || '—'}</td>
                <td>{row.distanceText || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sortedRows.length > 18 && (
        <button
          type="button"
          className="clipboard-show-all"
          aria-expanded={showAll}
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll ? 'Collapse' : `Show all (${sortedRows.length})`}
        </button>
      )}

      <p className="clipboard-intel-note">
        Comparison exists only for this run and does not save a movement chain.
        {snapshot.rejected > 0 && ` Rows skipped: ${snapshot.rejected}.`}
      </p>
    </section>
  )
}

export function ClipboardIntelPanel({ snapshot }: { snapshot: TacticalClipboardSnapshot }): React.JSX.Element {
  return snapshot.kind === 'dscan'
    ? <DscanResults snapshot={snapshot} />
    : <ProbeResults snapshot={snapshot} />
}
