import type { KillAlert, KillAlertAttacker } from '../../shared/kill-alert'
import type { FriendlyFleetMember, PilotContext } from '../../shared/pilot-context'
import { EveTypeImage } from './EveTypeImage'

export type OperationalLoadState = 'idle' | 'loading' | 'ready' | 'error'

export interface OperationalPanelStatus {
  state: OperationalLoadState
  connected?: boolean
  message?: string | null
  warnings?: readonly string[]
}

export interface OperationalIntelPanelsProps {
  pilotContext: PilotContext | null
  pilotStatus: OperationalPanelStatus
  killAlerts: readonly KillAlert[]
  killAlertStatus: OperationalPanelStatus
  resolveSystemName?: (solarSystemId: number) => string | null
  maxVisibleAlerts?: number
}

export interface FriendlyFleetPanelProps {
  context: PilotContext | null
  status: OperationalPanelStatus
}

export interface KillAlertPanelProps {
  alerts: readonly KillAlert[]
  status: OperationalPanelStatus
  resolveSystemName?: (solarSystemId: number) => string | null
  maxVisible?: number
}

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

export function OperationalIntelPanels({
  pilotContext,
  pilotStatus,
  killAlerts,
  killAlertStatus,
  resolveSystemName,
  maxVisibleAlerts
}: OperationalIntelPanelsProps): React.JSX.Element {
  return (
    <section className="operational-intel-panels" aria-label="Operational intelligence">
      <FriendlyFleetPanel context={pilotContext} status={pilotStatus} />
      <KillAlertPanel
        alerts={killAlerts}
        status={killAlertStatus}
        resolveSystemName={resolveSystemName}
        maxVisible={maxVisibleAlerts}
      />
    </section>
  )
}

export function FriendlyFleetPanel({
  context,
  status
}: FriendlyFleetPanelProps): React.JSX.Element {
  const fleet = context?.fleet ?? null
  const members = fleet
    ? [...fleet.members].sort((left, right) => {
        const ownDifference = Number(right.characterId === context?.characterId)
          - Number(left.characterId === context?.characterId)
        return ownDifference || memberName(left).localeCompare(memberName(right), 'en')
      })
    : []
  const systemCount = new Set(members.map((member) => member.solarSystemId)).size
  const shipCount = new Set(members.map((member) => member.shipTypeId)).size
  const warnings = mergeWarnings(status.warnings, context?.warnings)
  const rosterUnavailable = fleet !== null &&
    !fleet.membersAvailable &&
    status.state === 'ready'
  const rosterRequiresBoss = rosterUnavailable &&
    fleet.fleetBossId !== context?.characterId

  return (
    <article className="operational-panel operational-fleet-panel">
      <header className="operational-panel-heading">
        <div>
          <p className="operational-eyebrow">Friendly fleet · ESI</p>
          <h2>Friendly fleet</h2>
        </div>
        <SourceState
          status={status}
          readyLabel={rosterRequiresBoss
            ? 'Fleet boss only'
            : rosterUnavailable
              ? 'Roster is refreshing'
              : fleet
                ? 'ESI connected'
                : 'No fleet'}
        />
      </header>

      {fleet?.membersAvailable && status.state !== 'loading' ? (
        <>
          <div className="operational-metric-row" aria-label="Friendly fleet summary">
            <Metric label="Pilots" value={members.length} />
            <Metric label="Systems" value={systemCount} />
            <Metric label="Ship types" value={shipCount} />
            <Metric
              label="Without fleet warp"
              value={members.filter((member) => !member.takesFleetWarp).length}
              warning
            />
          </div>

          <div className="operational-fleet-list">
            {members.map((member) => (
              <FleetMemberCard
                key={member.characterId}
                member={member}
                ownCharacterId={context?.characterId ?? null}
              />
            ))}
          </div>
        </>
      ) : (
        <OperationalState
          state={rosterUnavailable ? 'ready' : status.state}
          title={rosterRequiresBoss
            ? 'Roster available to fleet boss'
            : rosterUnavailable
              ? 'ESI is refreshing the fleet roster'
              : fleetStateTitle(status)}
          message={rosterUnavailable
            ? rosterRequiresBoss
              ? 'You are in a fleet. ESI provides the full roster only to the fleet boss. Other intelligence continues to work.'
              : 'Your character is in a fleet, but the roster is temporarily unavailable. Refresh intelligence later; other data continues to work.'
            : status.message ?? fleetStateMessage(status)}
        />
      )}

      <WarningList warnings={warnings} />
      <p className="operational-boundary-note">
        <BoundaryIcon />
        <span>
          <strong>Friendly roster only.</strong> When allowed, ESI shows your fleet members,
          their ships, and their systems. This is not Local or an enemy list.
        </span>
      </p>
    </article>
  )
}

export function KillAlertPanel({
  alerts,
  status,
  resolveSystemName,
  maxVisible = 20
}: KillAlertPanelProps): React.JSX.Element {
  const safeLimit = Number.isSafeInteger(maxVisible) && maxVisible > 0
    ? Math.min(maxVisible, 100)
    : 20
  const sorted = [...alerts]
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
  const visible = sorted.slice(0, safeLimit)
  const backfillCount = alerts.filter((alert) => alert.historicalBackfill).length

  return (
    <article className="operational-panel operational-alert-panel" aria-live="polite">
      <header className="operational-panel-heading">
        <div>
          <p className="operational-eyebrow">Killmail feed · R2Z2</p>
          <h2>Combat messages</h2>
        </div>
        <SourceState status={status} readyLabel="Feed connected" />
      </header>

      <div className="operational-alert-summary">
        <span>
          <strong>{alerts.length}</strong>
          received
        </span>
        <span>
          <strong>{alerts.filter((alert) => alert.systemScope === 'current').length}</strong>
          current system
        </span>
        <span className={backfillCount > 0 ? 'operational-summary-warning' : ''}>
          <strong>{backfillCount}</strong>
          late backfill
        </span>
      </div>

      {visible.length > 0 ? (
        <div className="operational-alert-list">
          {visible.map((alert) => (
            <KillAlertCard
              key={`${alert.sequenceId}:${alert.killmailId}`}
              alert={alert}
              systemName={resolveSystemName?.(alert.solarSystemId) ?? null}
            />
          ))}
        </div>
      ) : (
        <OperationalState
          state={status.state}
          title={alertStateTitle(status)}
          message={status.message ?? alertStateMessage(status)}
        />
      )}

      {sorted.length > visible.length && (
        <p className="operational-limit-note">
          Showing {visible.length} of {sorted.length} messages
        </p>
      )}
      <WarningList warnings={status.warnings ?? []} />
      <p className="operational-boundary-note">
        <BoundaryIcon />
        <span>
          <strong>Not a live radar.</strong> R2Z2 reports uploaded killmails. Participants may have
          left the system; older killmails may appear in the feed later.
        </span>
      </p>
    </article>
  )
}

function FleetMemberCard({
  member,
  ownCharacterId
}: {
  member: FriendlyFleetMember
  ownCharacterId: number | null
}): React.JSX.Element {
  const own = member.characterId === ownCharacterId
  return (
    <article className={`operational-fleet-member${own ? ' operational-own-member' : ''}`}>
      <EveTypeImage
        typeId={member.shipTypeId}
        variant="render"
        requestSize={64}
        className="operational-fleet-ship-image"
      />
      <div className="operational-member-copy">
        <div className="operational-member-name">
          <strong>{memberName(member)}</strong>
          {own && <span>You</span>}
        </div>
        <span>{member.shipTypeName ?? `Ship · type ${member.shipTypeId}`}</span>
        <small>{member.roleName || roleLabel(member.role)}</small>
      </div>
      <div className="operational-member-location">
        <strong>{member.solarSystemName ?? `System ${member.solarSystemId}`}</strong>
        <span className={member.takesFleetWarp ? '' : 'operational-warp-warning'}>
          {member.takesFleetWarp ? 'Fleet warp enabled' : 'Fleet warp disabled'}
        </span>
      </div>
    </article>
  )
}

function KillAlertCard({
  alert,
  systemName
}: {
  alert: KillAlert
  systemName: string | null
}): React.JSX.Element {
  const capsuleerAttackers = alert.attackers.filter((attacker) => attacker.capsuleer)
  const victimName = alert.victim.shipTypeName ?? `Ship · type ${alert.victim.shipTypeId}`
  return (
    <article
      className={`operational-kill-card${
        alert.historicalBackfill ? ' operational-kill-backfill' : ''
      }`}
    >
      <EveTypeImage
        typeId={alert.victim.shipTypeId}
        variant="render"
        requestSize={64}
        className="operational-kill-ship-image"
      />
      <div className="operational-kill-copy">
        <div className="operational-kill-title">
          <strong>{victimName}</strong>
          <span className={`operational-scope-badge operational-scope-${alert.systemScope}`}>
            {alert.systemScope === 'current' ? 'Current' : 'Nearby'}
          </span>
          {alert.historicalBackfill && (
            <span className="operational-backfill-badge">Older killmail</span>
          )}
        </div>
        <span className="operational-kill-location">
          {systemName ?? `System ${alert.solarSystemId}`}
          {' · '}
          <time dateTime={alert.occurredAt}>{formatTimestamp(alert.occurredAt)}</time>
        </span>
        <small>
          {capsuleerAttackers.length} {capsuleerAttackers.length === 1 ? 'capsuleer' : 'capsuleers'}
          {' · '}report delay {formatDuration(alert.reportDelayMs)}
        </small>
      </div>
      <AttackerShips attackers={alert.attackers} />
      <div className="operational-kill-value">
        <strong>{formatIsk(alert.totalValue)}</strong>
        <span>Killmail #{alert.killmailId}</span>
      </div>
    </article>
  )
}

function AttackerShips({ attackers }: { attackers: readonly KillAlertAttacker[] }): React.JSX.Element {
  const unique = new Map<number, KillAlertAttacker>()
  for (const attacker of attackers) {
    if (attacker.shipTypeId !== null && !unique.has(attacker.shipTypeId)) {
      unique.set(attacker.shipTypeId, attacker)
    }
  }
  const ships = [...unique.values()].slice(0, 4)
  const hidden = Math.max(0, unique.size - ships.length)

  return (
    <div className="operational-attacker-ships" aria-label="Attacker ships">
      {ships.map((attacker) => (
        <span
          key={attacker.shipTypeId}
          title={`${attacker.shipTypeName ?? `Type ${attacker.shipTypeId}`}${
            attacker.capsuleer ? '' : ' · NPC'
          }`}
        >
          <EveTypeImage
            typeId={attacker.shipTypeId!}
            variant="icon"
            requestSize={32}
            className="operational-attacker-ship-image"
          />
        </span>
      ))}
      {hidden > 0 && <b>+{hidden}</b>}
    </div>
  )
}

function Metric({
  label,
  value,
  warning = false
}: {
  label: string
  value: number
  warning?: boolean
}): React.JSX.Element {
  return (
    <span className={warning && value > 0 ? 'operational-metric-warning' : ''}>
      <strong>{value}</strong>
      {label}
    </span>
  )
}

function SourceState({
  status,
  readyLabel
}: {
  status: OperationalPanelStatus
  readyLabel: string
}): React.JSX.Element {
  const connected = status.connected ?? status.state === 'ready'
  const label = status.state === 'loading'
    ? 'Connecting…'
    : status.state === 'error'
      ? 'Source unavailable'
      : connected
        ? readyLabel
        : 'Disconnected'
  return (
    <span
      className={`operational-source-state operational-source-${
        connected ? 'connected' : status.state
      }`}
    >
      <i />
      {label}
    </span>
  )
}

function OperationalState({
  state,
  title,
  message
}: {
  state: OperationalLoadState
  title: string
  message: string
}): React.JSX.Element {
  return (
    <div className={`operational-empty-state operational-state-${state}`}>
      {state === 'loading' && <span className="operational-loading-ring" />}
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  )
}

function WarningList({ warnings }: { warnings: readonly string[] }): React.JSX.Element | null {
  const unique = [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))]
  if (unique.length === 0) return null
  return (
    <ul className="operational-warning-list">
      {unique.map((warning) => <li key={warning}>{warning}</li>)}
    </ul>
  )
}

function BoundaryIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 4.8 6v5.1c0 4.5 2.8 8.2 7.2 9.9 4.4-1.7 7.2-5.4 7.2-9.9V6L12 3Z" />
      <path d="M12 7v6m0 3h.01" />
    </svg>
  )
}

function mergeWarnings(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined
): string[] {
  return [...new Set([...(first ?? []), ...(second ?? [])])]
}

function memberName(member: FriendlyFleetMember): string {
  return member.characterName ?? `Pilot ${member.characterId}`
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    fleet_commander: 'Fleet commander',
    wing_commander: 'Wing commander',
    squad_commander: 'Squad commander',
    squad_member: 'Squad member'
  }
  return labels[role] ?? role.replaceAll('_', ' ')
}

function fleetStateTitle(status: OperationalPanelStatus): string {
  if (status.state === 'loading') return 'Loading fleet roster'
  if (status.state === 'error') return 'Fleet data unavailable'
  if (status.state === 'idle') return 'Fleet not checked yet'
  return 'Character is not in a fleet'
}

function fleetStateMessage(status: OperationalPanelStatus): string {
  if (status.state === 'loading') return 'ESI returns only your friendly fleet.'
  if (status.state === 'error') return 'Check the connection and esi-fleets.read_fleet.v1 permission.'
  if (status.state === 'idle') return 'Connect a character and request Pilot Context.'
  return 'When the character joins a fleet, its members, ships, and systems will appear here.'
}

function alertStateTitle(status: OperationalPanelStatus): string {
  if (status.state === 'loading') return 'Connecting killmail feed'
  if (status.state === 'error') return 'R2Z2 is temporarily unavailable'
  if (status.state === 'idle') return 'Feed has not started yet'
  return 'No new killmails yet'
}

function alertStateMessage(status: OperationalPanelStatus): string {
  if (status.state === 'loading') return 'Receiving the zKillboard public-message stream.'
  if (status.state === 'error') return 'Saved messages remain historical observations.'
  if (status.state === 'idle') return 'The feed starts filtering after your current system is identified.'
  return 'This does not mean the system is safe: the source may delay or miss a killmail.'
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(timestamp) : 'time unknown'
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown'
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1_000)} sec.`
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} min.`
  if (milliseconds < 86_400_000) return `${Math.round(milliseconds / 3_600_000)} h`
  return `${Math.round(milliseconds / 86_400_000)} d`
}

function formatIsk(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Value unknown'
  if (value >= 1_000_000_000) return `${compactNumber(value / 1_000_000_000)}B ISK`
  if (value >= 1_000_000) return `${compactNumber(value / 1_000_000)}M ISK`
  if (value >= 1_000) return `${compactNumber(value / 1_000)}K ISK`
  return `${Math.round(value).toLocaleString('en-US')} ISK`
}

function compactNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: value < 10 ? 1 : 0 })
}
