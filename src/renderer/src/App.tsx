import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppStatus,
  CombatHistoryEntry,
  CombatHistoryKind,
  CombatHistoryPageInfo,
  CurrentSystemSnapshot,
  EveAccountStatus,
  EveLocalIntelApi,
  FitSection,
  KillAlert,
  LocalPreview,
  PilotCombatHistory,
  PilotContext,
  PilotIntel,
  RecentTargetProfileSnapshot,
  PilotWatchlistEntry,
  PilotWatchlistSnapshot,
  RouteIntelResult,
  SystemObservedPilot,
  SystemObservedShipOccurrence,
  ScanProgress,
  ScanResult,
  TargetProfile,
  ThreatLevel,
  UiSettings
} from '../../shared/types'
import {
  classifyEveClipboard,
  collectDscanTypeIds,
  enrichDscanRows,
  parseDscanClipboard,
  parseProbeClipboard,
  type DscanRow,
  type ProbeRow
} from '../../shared/clipboard-intel'
import { analyzeDscanIntelligence } from '../../shared/dscan-intelligence'
import {
  correlateDscanPilots,
  type DscanPilotCandidate
} from '../../shared/dscan-pilot-correlation'
import { formatAppVersion } from '../../shared/app-version'
import { normalizeKillAlertPollDelay } from '../../shared/kill-alert'
import {
  decideAutomaticClipboard,
  getClipboardNavigation,
  getClipboardScrollBehavior,
  getClipboardViewVisibility,
  routeEveClipboard,
  shouldApplyDeferredLocalNavigation,
  shouldDeferAutomaticLocalNavigation,
  type ActiveClipboardMode
} from '../../shared/clipboard-view'
import { parseLocalRoster } from '../../shared/local-parser'
import { upsertReadyPilot } from '../../shared/progressive-pilots'
import {
  applyPilotRosterSource,
  type PilotRosterObservationCandidate,
  type PilotRosterSource
} from '../../shared/pilot-roster-observation'
import { selectLastObservedPilotShip } from '../../shared/last-observed-pilot-ship'
import { buildRecentTargetProfile, selectTargetProfile } from '../../shared/target-profile'
import {
  assessPriorityRisk,
  formatPriorityRiskEvidence,
  isRiskPriority,
  riskPriorityLabel,
  riskPriorityTargetLabel,
  type PriorityEvidenceStatus,
  type PriorityRiskAssessment,
  type RiskPriority
} from '../../shared/priority-risk'
import {
  buildGangIntelligence,
  type GangIntelligence
} from '../../shared/gang-intelligence'
import {
  buildCorporationDossier,
  type CorporationDossier
} from '../../shared/corporation-dossier'
import {
  findPilotWatchlistMatches,
  findPilotWatchlistMatchedPilotIds,
  filterOperationalPilotWatchlistAlerts,
  getPilotWatchlistAlertSources,
  getPilotWatchlistEntityId,
  getPilotWatchlistEntityKey,
  getPilotWatchlistEntityType,
  getPilotWatchlistSeverity,
  reconcilePilotWatchlistDscanCandidates,
  reconcilePilotWatchlistPresence,
  shouldEmitPilotWatchlistAlert,
  shouldPlayPilotWatchlistAlert,
  toPilotWatchlistEntityKey,
  type PilotWatchlistAdvancedPatch,
  type PilotWatchlistEntityKey,
  type PilotWatchlistUpsertRequest
} from '../../shared/pilot-watchlist'
import {
  closePilotWorkspace,
  createPilotWorkspaceState,
  openPilotWorkspace,
  returnFromPilotWorkspace,
  selectWorkspace,
  type PilotWorkspaceTarget,
  type WorkspaceId
} from '../../shared/pilot-workspace-state'
import { EveTypeImage } from './EveTypeImage'
import {
  PilotFavoriteButton,
  type PilotFavoriteCandidate
} from './PilotFavoriteButton'
import { PilotWatchlistPanel } from './PilotWatchlistPanel'
import { FinanceWorkspace } from './FinanceWorkspace'
import { JournalWorkspace } from './JournalWorkspace'
import { MarketWorkspace } from './MarketWorkspace'
import { IndustryWorkspace } from './IndustryWorkspace'
import { IndustryProductionWorkspace } from './IndustryProductionWorkspace'
import { RouteWorkspace } from './RouteWorkspace'
import { SettingsWorkspace } from './SettingsWorkspace'
import { ProWorkspace } from './ProWorkspace'
import { NearbyPvePanel } from './NearbyPvePanel'
import { PriorityRiskControl } from './PriorityRiskControl'
import { hasProFeature, PRO_FEATURE_IDS } from '../../shared/pro-features'
import { applyUiSettingsToDocument } from './ui-settings-dom'
import { playPilotWatchlistAlert, tryPlayPilotWatchlistAlert } from './watchlist-audio'
import {
  ClipboardIntelPanel,
  type ProbeScanChanges,
  type TacticalClipboardSnapshot
} from './ClipboardIntelPanel'
import {
  OperationalIntelPanels,
  type OperationalPanelStatus
} from './OperationalIntelPanels'
import {
  CURRENT_SYSTEM_POLL_INTERVAL_MS,
  ESI_RATE_LIMIT_MESSAGE,
  isEsiRateLimitMessage,
  PILOT_CONTEXT_POLL_INTERVAL_MS,
  reconcileCurrentSystemSnapshot,
  sanitizeEsiMessage,
  startCurrentSystemPolling
} from '../../shared/current-system-ui'
import {
  DEFAULT_UI_SETTINGS,
  uiPollingIntervalsMs
} from '../../shared/ui-settings'

type SortKey =
  | 'name'
  | 'corporation'
  | 'alliance'
  | 'risk'
  | 'kills'
  | 'losses'
  | 'solo'
  | 'gang'
  | 'isk'

type SortDirection = 'asc' | 'desc'
type ThreatFilter = 'all' | ThreatLevel
type HistoryStatus = 'idle' | 'loading' | 'ready' | 'error'
type DetailsTab = 'profile' | 'kills' | 'losses' | 'gang' | 'corporation'
export type PilotWorkspaceSelection = PilotWorkspaceTarget

type OpenPilotWorkspace = (selection: PilotWorkspaceSelection) => void

export interface PilotHistoryState {
  status: HistoryStatus
  data?: PilotCombatHistory
  error?: string
}

export interface HistoryLoadMoreState {
  status: 'idle' | 'loading' | 'error'
  error?: string
}

interface PriorityEvidenceState {
  status: PriorityEvidenceStatus
  data?: RecentTargetProfileSnapshot
  error?: string
}

const THREAT_ORDER: Record<ThreatLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0
}

const THREAT_LABELS: Record<ThreatLevel, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'No data'
}

const FILTERS: Array<{ value: ThreatFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'unknown', label: 'Unknown' }
]

const AUTO_CLIPBOARD_KEY = 'eve-local-intel:auto-clipboard'
const WATCHLIST_SOUND_KEY = 'eve-local-intel:watchlist-sound'
const RISK_PRIORITY_KEY = 'eve-local-intel:risk-priority'
const EMPTY_WATCHLIST: PilotWatchlistSnapshot = {
  entries: [],
  updatedAt: new Date(0).toISOString()
}
const EVE_SSO_CALLBACK_FALLBACK = 'http://localhost:53173/callback'
const IS_WINDOWS_CLIENT = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)
const COPY_SHORTCUT = IS_WINDOWS_CLIENT ? 'Ctrl+C' : '⌘C'
const SELECT_ALL_COPY_SHORTCUT = IS_WINDOWS_CLIENT ? 'Ctrl+A → Ctrl+C' : '⌘A → ⌘C'
const MARKET_DRAFT_EVENT = 'fly-safe:market-draft'
const EMPTY_SYSTEM_IDS: readonly number[] = []

const SYSTEM_DANGER_LABELS = {
  critical: 'Critical',
  high: 'Dangerous',
  medium: 'Caution',
  low: 'Quiet',
  unknown: 'No data'
} as const

type TargetCategory = TargetProfile['entries'][number]['category']

const PRIMARY_TARGET_CATEGORIES: Array<{
  category: TargetCategory
  label: string
}> = [
  { category: 'scanner', label: 'Scanners' },
  { category: 'logistics', label: 'Logistics' },
  { category: 'mining', label: 'Mining' },
  { category: 'hauler', label: 'Haulers' },
  { category: 'combat', label: 'Combat' },
  { category: 'capital', label: 'Capitals' }
]

const OPTIONAL_TARGET_CATEGORIES: Array<{
  category: TargetCategory
  label: string
}> = [
  { category: 'pve', label: 'PvE' },
  { category: 'structure', label: 'Structures' },
  { category: 'other', label: 'Other' }
]

const DETAILS_TABS: Array<{ value: DetailsTab; label: string }> = [
  { value: 'profile', label: 'Target profile' },
  { value: 'kills', label: 'Recent kills' },
  { value: 'losses', label: 'Losses and fits' },
  { value: 'gang', label: 'Gang' },
  { value: 'corporation', label: 'Corporation' }
]

const FIT_SECTIONS: Array<{ value: FitSection; label: string }> = [
  { value: 'high', label: 'High slots' },
  { value: 'medium', label: 'Mid slots' },
  { value: 'low', label: 'Low slots' },
  { value: 'rig', label: 'Rigs' },
  { value: 'subsystem', label: 'Subsystems' },
  { value: 'drone', label: 'Drones' },
  { value: 'fighter', label: 'Fighters' },
  { value: 'cargo', label: 'Cargo' },
  { value: 'other', label: 'Other' }
]

function savedAutoClipboardPreference(): boolean {
  try {
    return window.localStorage.getItem(AUTO_CLIPBOARD_KEY) === 'true'
  } catch {
    return false
  }
}

function savedWatchlistSoundPreference(): boolean {
  try {
    return window.localStorage.getItem(WATCHLIST_SOUND_KEY) !== 'false'
  } catch {
    return true
  }
}

function savedRiskPriorityPreference(): RiskPriority {
  try {
    const saved = window.localStorage.getItem(RISK_PRIORITY_KEY)
    return isRiskPriority(saved) ? saved : 'general'
  } catch {
    return 'general'
  }
}

function compareProbeScans(
  previous: readonly ProbeRow[] | null,
  current: readonly ProbeRow[]
): ProbeScanChanges {
  if (previous === null) {
    return { comparable: false, added: [], removed: [], changed: [] }
  }

  const previousById = new Map(previous.map((row) => [row.id, row]))
  const currentById = new Map(current.map((row) => [row.id, row]))
  const added = [...currentById.keys()].filter((id) => !previousById.has(id)).sort()
  const removed = [...previousById.keys()].filter((id) => !currentById.has(id)).sort()
  const changed = [...currentById.entries()]
    .filter(([id, row]) => {
      const before = previousById.get(id)
      return before !== undefined && (
        before.group !== row.group ||
        before.type !== row.type ||
        before.name !== row.name ||
        before.signal !== row.signal ||
        before.distanceText !== row.distanceText
      )
    })
    .map(([id]) => id)
    .sort()

  return { comparable: true, added, removed, changed }
}

function getApi(): EveLocalIntelApi | null {
  return (window as Window & { eveIntel?: EveLocalIntelApi }).eveIntel ?? null
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error && error.message
    ? error.message
    : typeof error === 'string' && error
      ? error
      : 'Unknown error'
  return sanitizeEsiMessage(message)
}

function mergeCombatHistoryEntries(
  current: CombatHistoryEntry[],
  incoming: CombatHistoryEntry[]
): CombatHistoryEntry[] {
  const merged = [...current]
  const indexByKillmailId = new Map(
    current.map((entry, index) => [entry.killmailId, index] as const)
  )

  for (const entry of incoming) {
    const existingIndex = indexByKillmailId.get(entry.killmailId)
    if (existingIndex === undefined) {
      indexByKillmailId.set(entry.killmailId, merged.length)
      merged.push(entry)
    } else {
      // A later page may contain a fresher hydrated version of an overlapping killmail.
      merged[existingIndex] = entry
    }
  }

  return merged
}

export function mergeCombatHistoryPage(
  current: PilotCombatHistory,
  incoming: PilotCombatHistory,
  kind: CombatHistoryKind
): PilotCombatHistory {
  const listKey = kind === 'kill' ? 'kills' : 'losses'
  const pageInfo = incoming.pageInfo[kind]

  return {
    ...current,
    fetchedAt: incoming.fetchedAt,
    cached: current.cached && incoming.cached,
    [listKey]: mergeCombatHistoryEntries(current[listKey], incoming[listKey]),
    pageInfo: pageInfo
      ? { ...current.pageInfo, [kind]: pageInfo }
      : current.pageInfo,
    warnings: [...new Set([...current.warnings, ...incoming.warnings])]
  }
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value)}%`
}

function formatIsk(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value)
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(0, Math.round(durationMs))} ms`
  return `${(durationMs / 1000).toFixed(1)} sec`
}

function formatActivity(value: string | null | undefined): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric'
  }).format(new Date(timestamp))
}

function formatCombatDate(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function formatCombatValue(value: number | null): string {
  return value === null ? 'ISK unknown' : `${formatIsk(value)} ISK`
}

function PilotRelationshipBadges({ pilot }: { pilot: PilotIntel }): React.JSX.Element | null {
  const relationship = pilot.relationship
  if (!relationship) return null

  const standing = relationship.standing
  const standingLabel = standing === null
    ? null
    : `${standing > 0 ? '+' : ''}${standing.toFixed(1)}`
  const titleParts = [
    relationship.fleet ? 'Member of your fleet' : null,
    relationship.contact
      ? `Contact${standingLabel ? `: ${standingLabel}` : ''}`
      : null,
    relationship.labelNames.length > 0
      ? `Labels: ${relationship.labelNames.join(', ')}`
      : null
  ].filter((value): value is string => value !== null)

  if (titleParts.length === 0) return null

  return (
    <span className="pilot-relationship-badges" title={titleParts.join(' · ')}>
      {relationship.fleet && <b className="relationship-fleet">FLEET</b>}
      {relationship.contact && (
        <b className={`relationship-${relationship.standingClass}`}>
          {relationship.standingClass === 'positive'
            ? `BLUE ${standingLabel}`
            : relationship.standingClass === 'negative'
              ? `RED ${standingLabel}`
              : 'CONTACT'}
        </b>
      )}
      {relationship.labelNames.slice(0, 1).map((label) => (
        <b className="relationship-label" key={label}>{label}</b>
      ))}
    </span>
  )
}

export function PilotIntelIdentityCell({
  pilot,
  watchlisted,
  watchlistMatch,
  favoritePending = false,
  onOpen,
  onToggleFavorite
}: {
  pilot: PilotIntel
  watchlisted: boolean
  watchlistMatch: boolean
  favoritePending?: boolean
  onOpen: () => void
  onToggleFavorite: (pilot: PilotFavoriteCandidate) => void
}): React.JSX.Element {
  const indirectWatchlistLabel = watchlistMatch && !watchlisted
    ? 'Corporation / alliance on watchlist'
    : null

  return (
    <div className="pilot-cell-inner">
      <button
        type="button"
        className="profile-toggle"
        onClick={onOpen}
        aria-label={`Open full pilot card for ${pilot.name}`}
        title="Open profile, kills, losses, and fits in a separate tab"
      >
        <span aria-hidden="true">›</span>
      </button>
      <PilotFavoriteButton
        pilot={{
          characterId: pilot.id,
          name: pilot.name,
          corporationName: pilot.corporationName
        }}
        favorite={watchlisted}
        pending={favoritePending}
        onToggle={onToggleFavorite}
      />
      <span className={`threat-light ${pilot.threatLevel}`} aria-hidden="true" />
      <div className="pilot-copy">
        <div className="pilot-name-line">
          <button
            type="button"
            className="pilot-name-button"
            onClick={onOpen}
            aria-label={`Open full pilot card for ${pilot.name}`}
            title={pilot.name}
          >
            {pilot.name}
          </button>
          {indirectWatchlistLabel && (
            <span className="watchlist-row-label" title={indirectWatchlistLabel}>
              {indirectWatchlistLabel}
            </span>
          )}
          <PilotRelationshipBadges pilot={pilot} />
        </div>
        <small>
          {pilot.error
            ? pilot.error
            : pilot.cached
              ? 'cached'
              : pilot.stats?.lastActivity
                ? `active: ${formatActivity(pilot.stats.lastActivity)}`
                : 'fresh data'}
        </small>
      </div>
    </div>
  )
}

function compareText(a: string | null, b: string | null): number {
  return (a ?? '').localeCompare(b ?? '', 'ru', { sensitivity: 'base' })
}

function ProgressivePilotRows({ pilots }: { pilots: readonly PilotIntel[] }): React.JSX.Element {
  return (
    <section className="progressive-pilots" role="status" aria-live="polite">
      <div className="progressive-pilots-header">
        <div>
          <p className="eyebrow">Ready results</p>
          <strong>Pilots appear immediately</strong>
        </div>
        <span>{pilots.length}</span>
      </div>
      <div className="progressive-pilot-list">
        {pilots.map((pilot) => (
          <article className={`progressive-pilot-row ${pilot.threatLevel}`} key={pilot.id}>
            <span className={`threat-light ${pilot.threatLevel}`} aria-hidden="true" />
            <div className="progressive-pilot-identity">
              <strong>{pilot.name}</strong>
              <small>
                {[pilot.corporationName, pilot.allianceName].filter(Boolean).join(' · ') ||
                  'Corporation unknown'}
              </small>
            </div>
            <div className={`threat-badge ${pilot.threatLevel}`}>
              <span>{THREAT_LABELS[pilot.threatLevel]}</span>
              {pilot.threatLevel !== 'unknown' && <b>{pilot.threatScore}</b>}
            </div>
            <dl className="progressive-pilot-metrics">
              <div><dt>K</dt><dd>{pilot.stats?.shipsDestroyed ?? '—'}</dd></div>
              <div><dt>L</dt><dd>{pilot.stats?.shipsLost ?? '—'}</dd></div>
              <div><dt>ISK</dt><dd>{formatIsk(pilot.stats?.iskDestroyed)}</dd></div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  )
}

function sortValue(pilot: PilotIntel, key: SortKey): string | number | null {
  switch (key) {
    case 'name':
      return pilot.name
    case 'corporation':
      return pilot.corporationName
    case 'alliance':
      return pilot.allianceName
    case 'risk':
      return pilot.threatScore ?? THREAT_ORDER[pilot.threatLevel]
    case 'kills':
      return pilot.stats?.shipsDestroyed ?? null
    case 'losses':
      return pilot.stats?.shipsLost ?? null
    case 'solo':
      return pilot.stats?.soloRatio ?? null
    case 'gang':
      return pilot.stats?.gangRatio ?? null
    case 'isk':
      return pilot.stats?.iskDestroyed ?? null
  }
}

function sortPilots(
  pilots: PilotIntel[],
  key: SortKey,
  direction: SortDirection
): PilotIntel[] {
  return [...pilots].sort((a, b) => {
    const left = sortValue(a, key)
    const right = sortValue(b, key)
    let compared: number

    if (typeof left === 'string' || typeof right === 'string') {
      compared = compareText(
        typeof left === 'string' ? left : null,
        typeof right === 'string' ? right : null
      )
    } else if (left == null && right == null) {
      compared = 0
    } else if (left == null) {
      compared = -1
    } else if (right == null) {
      compared = 1
    } else {
      compared = left - right
    }

    if (compared === 0) compared = compareText(a.name, b.name)
    return direction === 'asc' ? compared : -compared
  })
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="m12.5 12.5 4 4" />
    </svg>
  )
}

function ClipboardIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M7 5.5H5.75A1.75 1.75 0 0 0 4 7.25v8A1.75 1.75 0 0 0 5.75 17h8.5A1.75 1.75 0 0 0 16 15.25v-8a1.75 1.75 0 0 0-1.75-1.75H13" />
      <rect x="7" y="3" width="6" height="4" rx="1.5" />
    </svg>
  )
}

function RadarIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 12 18.2 6M12 2v2M22 12h-2M12 22v-2M2 12h2" />
    </svg>
  )
}

function WarningIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M9.1 3.3 2.4 15a1.1 1.1 0 0 0 1 1.7h13.2a1.1 1.1 0 0 0 1-1.7L10.9 3.3a1 1 0 0 0-1.8 0Z" />
      <path d="M10 7v4.5M10 14.2v.1" />
    </svg>
  )
}

export function PilotRosterObservationCard({
  source,
  systemId,
  systemName,
  confirming,
  onConfirm
}: {
  source: PilotRosterSource
  systemId: number | null
  systemName: string | null
  confirming: boolean
  onConfirm: () => void
}): React.JSX.Element {
  const confirmed = source === 'confirmed-local'
  return (
    <section
      className={`local-observation-card ${confirmed ? 'confirmed' : 'lookup'}`}
      role="status"
      aria-live="polite"
    >
      <span className="local-observation-icon" aria-hidden="true">
        {confirmed ? '✓' : '?'}
      </span>
      <div className="local-observation-copy">
        <strong>
          {confirmed
            ? 'Local confirmed and added to Hunter'
            : 'Regular check — Hunter unchanged'}
        </strong>
        <small>
          {confirmed
            ? `${systemName ?? `System ${systemId}`} · encounter saved once`
            : systemId === null
              ? 'Current system was unknown when checked, so this result cannot be recorded as Local.'
              : `If this is real Local for ${systemName ?? systemId}, add the observation manually.`}
        </small>
      </div>
      {!confirmed && (
        <button
          type="button"
          className="secondary-button local-observation-confirm"
          onClick={onConfirm}
          disabled={systemId === null || confirming}
          title={systemId === null
            ? 'Wait until current system is known first'
            : 'Record this encounter in Journal and Hunter Planner'}
        >
          <RadarIcon />
          {confirming ? 'Saving…' : 'Add as Local'}
        </button>
      )}
    </section>
  )
}

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  align = 'left',
  onSort
}: {
  label: string
  sortKey: SortKey
  activeKey: SortKey
  direction: SortDirection
  align?: 'left' | 'right'
  onSort: (key: SortKey) => void
}): React.JSX.Element {
  const active = activeKey === sortKey
  return (
    <th scope="col" className={align === 'right' ? 'numeric' : undefined}>
      <button
        type="button"
        className={`sort-button ${active ? 'active' : ''}`}
        onClick={() => onSort(sortKey)}
        aria-label={`${label}: ${
          active
            ? direction === 'asc'
              ? 'ascending'
              : 'descending'
            : 'sort'
        }`}
      >
        <span>{label}</span>
        <span className="sort-arrow" aria-hidden="true">
          {active ? (direction === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  )
}

function SummaryCard({
  label,
  value,
  detail,
  tone
}: {
  label: string
  value: number
  detail: string
  tone: 'neutral' | 'danger' | 'warning' | 'info'
}): React.JSX.Element {
  return (
    <article className={`summary-card ${tone}`}>
      <div className="summary-marker" aria-hidden="true" />
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{detail}</span>
      </div>
    </article>
  )
}

function TargetProfilePanel({
  profile,
  source
}: {
  profile: TargetProfile
  source: 'lifetime' | 'recent'
}): React.JSX.Element {
  const entries = new Map(profile.entries.map((entry) => [entry.category, entry]))
  const visibleCategories = [
    ...PRIMARY_TARGET_CATEGORIES,
    ...OPTIONAL_TARGET_CATEGORIES.filter(
      ({ category }) => (entries.get(category)?.kills ?? 0) > 0
    )
  ]
  const coverage =
    profile.totalKills > 0
      ? Math.min(100, Math.round((profile.categorizedKills / profile.totalKills) * 100))
      : 0

  return (
    <div className="target-profile">
      <div className="target-profile-heading">
        <div>
          <p className="target-profile-eyebrow">Target profile</p>
          <strong>Destroyed hull types</strong>
        </div>
        <div className="target-profile-coverage">
          <span>Classified by role</span>
          <b>{coverage}%</b>
          <small>
            {profile.categorizedKills.toLocaleString('en-US')} of{' '}
            {profile.totalKills.toLocaleString('en-US')} kills
          </small>
        </div>
      </div>

      <div className="target-category-grid">
        {visibleCategories.map(({ category, label }) => {
          const entry = entries.get(category)
          const kills = entry?.kills ?? 0
          const share = entry?.share ?? 0
          const safeShare = Math.min(100, Math.max(0, share * 100))

          return (
            <article className={`target-category target-${category}`} key={category}>
              <div className="target-category-copy">
                <span>{label}</span>
                <b>{kills.toLocaleString('en-US')}</b>
              </div>
              <div
                className="target-share-track"
                role="progressbar"
                aria-label={`${label}: ${Math.round(safeShare)}% of targets`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(safeShare)}
              >
                <span style={{ width: `${safeShare}%` }} />
              </div>
              <small>{Math.round(safeShare)}%</small>
            </article>
          )
        })}
      </div>

      <p className="target-profile-note">
        {source === 'recent'
          ? 'Exact victim hulls from available killmails. A hull role does not describe its fit or the pilot’s intent.'
          : 'Public zKillboard kill groups. Mixed groups stay in “Other” without guessing their role.'}
      </p>
    </div>
  )
}

function openFitInMarket(entry: CombatHistoryEntry): void {
  const fit = entry.victimFit
  const shipName = fit.shipName ?? `Type ${fit.shipTypeId}`
  const items = FIT_SECTIONS.flatMap(({ value }) => fit.sections[value])
    .flatMap((item) => {
      const quantity = item.quantityDestroyed + item.quantityDropped
      return quantity > 0 ? [`${item.name ?? `Type ${item.typeId}`} x${quantity}`] : []
    })
  const text = [`[${shipName}, Killmail ${entry.killmailId}]`, ...items].join('\n')
  window.dispatchEvent(new CustomEvent(MARKET_DRAFT_EVENT, { detail: { text } }))
}

function ShipFitPanel({ entry }: { entry: CombatHistoryEntry }): React.JSX.Element {
  const fit = entry.victimFit
  const visibleSections = FIT_SECTIONS.filter(
    ({ value }) => fit.sections[value].length > 0
  )

  return (
    <div className="ship-fit" role="region" aria-label={`Fit ${fit.shipName ?? fit.shipTypeId}`}>
      <div className="ship-fit-heading">
        <div className="ship-fit-identity">
          <EveTypeImage
            typeId={fit.shipTypeId}
            variant="render"
            requestSize={256}
            className="fit-ship-image"
          />
          <div className="ship-fit-copy">
            <span>{entry.kind === 'kill' ? 'Victim fit' : 'Fit at time of loss'}</span>
            <strong>{fit.shipName ?? `Ship type ${fit.shipTypeId}`}</strong>
          </div>
        </div>
        <div className="ship-fit-heading-actions">
          <small>
            Destroyed: {fit.totalDestroyed.toLocaleString('en-US')} · Dropped:{' '}
            {fit.totalDropped.toLocaleString('en-US')}
          </small>
          <button
            type="button"
            className="secondary-button ship-fit-market-button"
            onClick={() => openFitInMarket(entry)}
          >
            Appraise fit
          </button>
        </div>
      </div>

      {visibleSections.length === 0 ? (
        <p className="fit-empty">This killmail has no module data.</p>
      ) : (
        <div className="fit-sections">
          {visibleSections.map(({ value, label }) => (
            <section className={`fit-section fit-${value}`} key={value}>
              <h4>{label}</h4>
              <ul>
                {fit.sections[value].map((item) => {
                  const total = item.quantityDestroyed + item.quantityDropped
                  return (
                    <li className="fit-item-row" key={`${value}-${item.typeId}`}>
                      <EveTypeImage
                        typeId={item.typeId}
                        variant="icon"
                        requestSize={64}
                        className="fit-item-image"
                      />
                      <div className="fit-item-copy">
                        <div>
                          <span>{item.name ?? `Type ${item.typeId}`}</span>
                          {total > 1 && <b>×{total.toLocaleString('en-US')}</b>}
                        </div>
                        <small>
                          {item.quantityDestroyed > 0 && (
                            <span className="destroyed">
                              destroyed {item.quantityDestroyed.toLocaleString('en-US')}
                            </span>
                          )}
                          {item.quantityDropped > 0 && (
                            <span className="dropped">
                              dropped {item.quantityDropped.toLocaleString('en-US')}
                            </span>
                          )}
                        </small>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function pilotCountLabel(count: number): string {
  return `${count} pilot${Math.abs(count) === 1 ? '' : 's'}`
}

function combatParticipantLabel(entry: CombatHistoryEntry): string {
  if (entry.attackerCount === 0 && entry.nonCapsuleerAttackerCount === 0) {
    return 'No participants listed'
  }

  return [
    pilotCountLabel(entry.attackerCount),
    entry.nonCapsuleerAttackerCount > 0
      ? `${entry.nonCapsuleerAttackerCount} NPC/structures`
      : null
  ].filter((part): part is string => part !== null).join(' + ')
}

function CombatAttackersPanel({
  entry,
  focusedCharacterId,
  onOpenPilot
}: {
  entry: CombatHistoryEntry
  focusedCharacterId: number
  onOpenPilot?: OpenPilotWorkspace
}): React.JSX.Element {
  const corporations = new Set(
    entry.attackers.map((attacker) => attacker.corporationId).filter((id) => id !== null)
  )
  const alliances = new Set(
    entry.attackers.map((attacker) => attacker.allianceId).filter((id) => id !== null)
  )
  const groupSummary = [
    corporations.size > 0 ? `${corporations.size} corporations` : null,
    alliances.size > 0 ? `${alliances.size} alliances` : null,
    entry.nonCapsuleerAttackerCount > 0
      ? `NPC/structures: ${entry.nonCapsuleerAttackerCount}`
      : null
  ].filter((part): part is string => part !== null)

  return (
    <section className="combat-attackers" aria-labelledby={`killmail-attackers-${entry.killmailId}`}>
      <header className="combat-attackers-heading">
        <div>
          <p>Killmail · joint attack</p>
          <h4 id={`killmail-attackers-${entry.killmailId}`}>Attackers</h4>
          <small>{groupSummary.join(' · ') || 'No organizations listed'}</small>
        </div>
        <strong>{pilotCountLabel(entry.attackerCount)}</strong>
      </header>

      {entry.attackers.length === 0 ? (
        <p className="combat-attackers-empty">No capsuleer attackers listed in this killmail.</p>
      ) : (
        <div className="combat-attacker-list">
          {entry.attackers.map((attacker) => {
            const focused = attacker.characterId === focusedCharacterId
            const shipName = attacker.shipName ??
              (attacker.shipTypeId === null ? 'Ship unknown' : `Type ${attacker.shipTypeId}`)
            const organization = [attacker.corporationName, attacker.allianceName]
              .filter(Boolean)
              .join(' · ') || 'Organization unknown'
            const content = (
              <>
                {attacker.shipTypeId === null ? (
                  <span className="combat-attacker-ship-placeholder" aria-hidden="true">?</span>
                ) : (
                  <EveTypeImage
                    typeId={attacker.shipTypeId}
                    variant="icon"
                    requestSize={64}
                    className="combat-attacker-ship-image"
                  />
                )}
                <span className="combat-attacker-identity">
                  <strong>{attacker.name ?? `Pilot ${attacker.characterId}`}</strong>
                  <small>{organization}</small>
                </span>
                <span className="combat-attacker-hull">
                  <strong>{shipName}</strong>
                  <small>
                    {attacker.weaponName
                      ? `Weapon: ${attacker.weaponName}`
                      : 'Weapon not listed'}
                  </small>
                </span>
                <span className="combat-attacker-damage">
                  <strong>{attacker.damageDone.toLocaleString('en-US')}</strong>
                  <small>damage</small>
                </span>
                <span className="combat-attacker-tags">
                  {focused && <b className="focused">THIS PILOT</b>}
                  {attacker.finalBlow && <b className="final">FINAL</b>}
                </span>
              </>
            )

            return onOpenPilot ? (
              <button
                key={attacker.characterId}
                type="button"
                className={`combat-attacker-row ${focused ? 'focused' : ''}`}
                aria-label={`Open full card for participant ${attacker.name ?? attacker.characterId}`}
                onClick={() => onOpenPilot({
                  characterId: attacker.characterId,
                  name: attacker.name,
                  sourceLabel: `Killmail #${entry.killmailId} · attacker`
                })}
              >
                {content}
              </button>
            ) : (
              <div
                key={attacker.characterId}
                className={`combat-attacker-row ${focused ? 'focused' : ''}`}
              >
                {content}
              </div>
            )
          })}
        </div>
      )}

      {entry.attackersCapped && (
        <p className="combat-attackers-cap">
          Showing first {entry.attackers.length} of {entry.attackerCount} attackers by FINAL and damage.
        </p>
      )}
      <p className="combat-attackers-note">
        A joint killmail shows participation in one fight, not a permanent gang composition.
      </p>
    </section>
  )
}

export function CombatHistoryCard({
  entry,
  expanded,
  focusedCharacterId,
  onToggle,
  onOpenPilot
}: {
  entry: CombatHistoryEntry
  expanded: boolean
  focusedCharacterId: number
  onToggle: () => void
  onOpenPilot?: OpenPilotWorkspace
}): React.JSX.Element {
  const shipName = entry.victimFit.shipName ?? `Type ${entry.victimFit.shipTypeId}`
  const victim = entry.victimName ?? entry.victimCorporationName ?? 'Victim not listed'
  const detailId = `killmail-fit-${entry.killmailId}`

  return (
    <article className={`combat-card ${entry.kind} ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="combat-card-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={detailId}
      >
        <span className="combat-chevron" aria-hidden="true">›</span>
        <EveTypeImage
          typeId={entry.victimFit.shipTypeId}
          variant="render"
          requestSize={128}
          className="combat-ship-image"
        />
        <span className="combat-ship">
          <strong>{shipName}</strong>
          <small>
            {entry.kind === 'kill' ? `Victim: ${victim}` : `Pilot: ${victim}`}
          </small>
        </span>
        <span className="combat-place">
          <strong>{entry.solarSystemName ?? `System ${entry.solarSystemId}`}</strong>
          <small>{formatCombatDate(entry.time)}</small>
        </span>
        <span className="combat-value">
          <strong>{formatCombatValue(entry.totalValue)}</strong>
          <small className="combat-value-detail">
            <b
              className="combat-participant-count"
              title="Attacking pilots; victim is not included in this count"
            >
              {combatParticipantLabel(entry)}
            </b>
            <span>
              {entry.kind === 'kill' && entry.attackerShipName
                ? `Attacked in ${entry.attackerShipName}`
                : entry.solo && entry.attackerCount <= 1
                  ? 'solo'
                  : `Killmail #${entry.killmailId}`}
            </span>
          </small>
        </span>
        <span className="combat-tags">
          {entry.solo && entry.attackerCount <= 1 && <b>SOLO</b>}
          {entry.pilotFinalBlow && <b>FINAL</b>}
        </span>
      </button>
      {expanded && (
        <div id={detailId}>
          <CombatAttackersPanel
            entry={entry}
            focusedCharacterId={focusedCharacterId}
            onOpenPilot={onOpenPilot}
          />
          <ShipFitPanel entry={entry} />
        </div>
      )}
    </article>
  )
}

export function CombatHistoryList({
  entries,
  kind,
  pageInfo,
  loadMoreState,
  expandedKillmailId,
  focusedCharacterId,
  onToggleKillmail,
  onLoadMore,
  onOpenPilot
}: {
  entries: CombatHistoryEntry[]
  kind: CombatHistoryKind
  pageInfo?: CombatHistoryPageInfo
  loadMoreState: HistoryLoadMoreState
  expandedKillmailId: number | null
  focusedCharacterId: number
  onToggleKillmail: (killmailId: number) => void
  onLoadMore: () => void
  onOpenPilot?: OpenPilotWorkspace
}): React.JSX.Element {
  const loadingMore = loadMoreState.status === 'loading'
  const canLoadMore = pageInfo?.hasMore === true

  return (
    <div className="combat-history-list">
      {entries.length === 0 ? (
        <div className="history-empty">
          <strong>{kind === 'kill' ? 'No kills found' : 'No losses found'}</strong>
          <p>No matching killmails in public zKillboard history.</p>
        </div>
      ) : entries.map((entry) => (
          <CombatHistoryCard
            key={entry.killmailId}
            entry={entry}
            expanded={expandedKillmailId === entry.killmailId}
            focusedCharacterId={focusedCharacterId}
            onToggle={() => onToggleKillmail(entry.killmailId)}
            onOpenPilot={onOpenPilot}
          />
        ))}

      <div className="history-pagination" aria-live="polite">
        <p className="history-limit-note">
          {pageInfo
            ? canLoadMore
              ? `Showing ${entries.length} entries.`
              : pageInfo.capped
                ? `Safe loading limit reached · showing ${entries.length}.`
                : `No more entries in available history · showing ${entries.length}.`
            : `Showing latest ${entries.length} entries.`}
        </p>
        {loadMoreState.status === 'error' && (
          <p className="history-load-more-error" role="alert">
            Could not load next batch: {loadMoreState.error}
          </p>
        )}
        {canLoadMore && (
          <button
            type="button"
            className="secondary-button history-load-more-button"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore
              ? 'Loading 50 more…'
              : loadMoreState.status === 'error'
                ? 'Retry · 50 more'
                : 'Load 50 more'}
          </button>
        )}
      </div>
    </div>
  )
}

function PilotDetailsPanel({
  pilot,
  tab,
  historyState,
  loadMoreState,
  expandedKillmailId,
  instanceId = 'local',
  onTabChange,
  onRetry,
  onLoadMore,
  onToggleKillmail,
  onOpenPilot
}: {
  pilot: PilotIntel
  tab: DetailsTab
  historyState: PilotHistoryState
  loadMoreState: Record<CombatHistoryKind, HistoryLoadMoreState>
  expandedKillmailId: number | null
  instanceId?: string
  onTabChange: (tab: DetailsTab) => void
  onRetry: () => void
  onLoadMore: (kind: CombatHistoryKind) => void
  onToggleKillmail: (killmailId: number) => void
  onOpenPilot?: OpenPilotWorkspace
}): React.JSX.Element {
  const lifetimeProfile = pilot.stats?.targetProfile
  const recentKills = historyState.data?.kills ?? []
  const recentProfile = recentKills.length === 0
    ? null
    : buildRecentTargetProfile(
        recentKills.map((entry) => ({
          shipName: entry.victimFit.shipName ?? null,
          shipTypeId: entry.victimFit.shipTypeId,
          groupId: entry.victimShipGroupId ?? null
        }))
      )
  const killPage = historyState.data?.pageInfo.kill
  const recentComplete = Boolean(
    historyState.status === 'ready' &&
    killPage &&
    !killPage.hasMore &&
    !killPage.capped &&
    !historyState.data?.warnings.some((warning) =>
      /^(?:zKill kills:|Killmail |ESI: victim hull groups|Skipped incomplete killmails)/u
        .test(warning)
    )
  )
  const profileSelection = selectTargetProfile(
    lifetimeProfile,
    recentProfile,
    recentComplete
  )
  const profile = profileSelection.profile
  const detailsId = `${instanceId}-${pilot.id}`
  const allHistory = useMemo(
    () => historyState.data
      ? [...historyState.data.kills, ...historyState.data.losses]
      : [],
    [historyState.data]
  )
  const gangIntelligence = useMemo(
    () => buildGangIntelligence(allHistory, pilot.id),
    [allHistory, pilot.id]
  )
  const corporationDossier = useMemo(
    () => pilot.corporationId !== null || pilot.corporationName
      ? buildCorporationDossier(allHistory, {
          ...(pilot.corporationId !== null ? { corporationId: pilot.corporationId } : {}),
          ...(pilot.corporationName ? { corporationName: pilot.corporationName } : {})
        })
      : null,
    [allHistory, pilot.corporationId, pilot.corporationName]
  )
  const historyEntries =
    tab === 'kills' ? historyState.data?.kills : historyState.data?.losses

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ): void => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % DETAILS_TABS.length
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + DETAILS_TABS.length) % DETAILS_TABS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = DETAILS_TABS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextTab = DETAILS_TABS[nextIndex].value
    onTabChange(nextTab)
    window.requestAnimationFrame(() => {
      document.getElementById(`pilot-tab-${detailsId}-${nextTab}`)?.focus()
    })
  }

  return (
    <div className="pilot-details">
      <div className="pilot-detail-tabs" role="tablist" aria-label={`Pilot data: ${pilot.name}`}>
        {DETAILS_TABS.map(({ value, label }, index) => (
          <button
            id={`pilot-tab-${detailsId}-${value}`}
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`pilot-panel-${detailsId}-${value}`}
            tabIndex={tab === value ? 0 : -1}
            className={tab === value ? 'active' : ''}
            onClick={() => onTabChange(value)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {label}
            {value === 'kills' && historyState.data && <span>{historyState.data.kills.length}</span>}
            {value === 'losses' && historyState.data && <span>{historyState.data.losses.length}</span>}
            {value === 'gang' && historyState.data && <span>{gangIntelligence.frequentCoPilots.length}</span>}
            {value === 'corporation' && corporationDossier && <span>{corporationDossier.observedPilots.length}</span>}
          </button>
        ))}
      </div>

      <div
        id={`pilot-panel-${detailsId}-${tab}`}
        role="tabpanel"
        aria-labelledby={`pilot-tab-${detailsId}-${tab}`}
        className="pilot-detail-panel"
      >
        {tab === 'profile' ? (
          profile ? (
            <>
              <TargetProfilePanel
                profile={profile}
                source={profileSelection.source === 'recent' ? 'recent' : 'lifetime'}
              />
              {profileSelection.source === 'recent' && recentProfile && (
                <p className="history-warning">
                  {lifetimeProfile
                    ? `All ${recentKills.length} kills were checked against exact hulls; aggregated zKillboard groups were not used.`
                    : `Profile built from ${recentKills.length} available killmails because this entity has no separate statistics.`}
                </p>
              )}
            </>
          ) : (
            <div className="history-empty">
              <strong>Target profile unavailable</strong>
              <p>You can still open kill and loss history.</p>
            </div>
          )
        ) : historyState.status === 'loading' || historyState.status === 'idle' ? (
          <div className="history-loading" role="status">
            <span />
            <span />
            <span />
            <p>Loading killmails and module names…</p>
          </div>
        ) : historyState.status === 'error' ? (
          <div className="history-error" role="alert">
            <strong>History did not load</strong>
            <p>{historyState.error}</p>
            <button type="button" onClick={onRetry}>Retry</button>
          </div>
        ) : tab === 'gang' ? (
          <GangIntelligencePanel intelligence={gangIntelligence} onOpenPilot={onOpenPilot} />
        ) : tab === 'corporation' ? (
          <CorporationDossierPanel dossier={corporationDossier} onOpenPilot={onOpenPilot} />
        ) : (
          <CombatHistoryList
            entries={historyEntries ?? []}
            kind={tab === 'kills' ? 'kill' : 'loss'}
            pageInfo={historyState.data?.pageInfo[tab === 'kills' ? 'kill' : 'loss']}
            loadMoreState={loadMoreState[tab === 'kills' ? 'kill' : 'loss']}
            expandedKillmailId={expandedKillmailId}
            focusedCharacterId={pilot.id}
            onToggleKillmail={onToggleKillmail}
            onLoadMore={() => onLoadMore(tab === 'kills' ? 'kill' : 'loss')}
            onOpenPilot={onOpenPilot}
          />
        )}
      </div>

      {tab !== 'profile' && historyState.data && historyState.data.warnings.length > 0 && (
        <p className="history-warning">{historyState.data.warnings.join(' · ')}</p>
      )}
    </div>
  )
}

function GangIntelligencePanel({
  intelligence,
  onOpenPilot
}: {
  intelligence: GangIntelligence
  onOpenPilot?: OpenPilotWorkspace
}): React.JSX.Element {
  if (intelligence.sample.qualifyingKills === 0) {
    return (
      <div className="history-empty">
        <strong>No regular co-pilots identified yet</strong>
        <p>The available sample has no kills where this pilot is listed as an attacker.</p>
      </div>
    )
  }

  return (
    <div className="behavior-intel-panel">
      <div className="behavior-summary">
        <span><b>{intelligence.sample.qualifyingKills}</b> kills in sample</span>
        <span><b>{intelligence.frequentCoPilots.length}</b> co-pilots</span>
        <span><b>{intelligence.stableGroups.length}</b> recurring groups</span>
      </div>

      <section className="behavior-section">
        <div className="section-heading compact">
          <div><p className="eyebrow">Killmail links</p><h3>Frequent co-pilots</h3></div>
        </div>
        <div className="behavior-pilot-grid">
          {intelligence.frequentCoPilots.map((coPilot) => (
            <button
              type="button"
              className="behavior-pilot-card"
              key={coPilot.characterId}
              disabled={!onOpenPilot}
              onClick={() => onOpenPilot?.({
                characterId: coPilot.characterId,
                name: coPilot.name,
                sourceLabel: 'Gang · public killmails'
              })}
            >
              <span className="behavior-pilot-title">
                <strong>{coPilot.name ?? `Pilot ${coPilot.characterId}`}</strong>
                <b>{coPilot.sharedKillmails}×</b>
              </span>
              <small>{coPilot.corporationName ?? 'Corporation unknown'} · {Math.round(coPilot.shareOfSample * 100)}% of sample</small>
              <span className="behavior-tags">
                {coPilot.ships.slice(0, 4).map((ship) => (
                  <i key={`${ship.typeId}-${ship.name}`}>{ship.name ?? ship.typeId ?? 'ship'} ×{ship.count}</i>
                ))}
              </span>
              <em>Last joint fight: {formatCombatDate(coPilot.lastSeen)}</em>
            </button>
          ))}
        </div>
      </section>

      <section className="behavior-section">
        <div className="section-heading compact">
          <div><p className="eyebrow">Composition recurrence</p><h3>Stable groups</h3></div>
        </div>
        {intelligence.stableGroups.length === 0 ? (
          <div className="behavior-empty">The same full composition has not repeated at least twice yet.</div>
        ) : (
          <div className="stable-gang-list">
            {intelligence.stableGroups.map((group) => (
              <article key={group.memberCharacterIds.join('-')}>
                <div><strong>{group.occurrences} joint fights</strong><small>{Math.round(group.shareOfSample * 100)}% of sample · {formatCombatDate(group.lastSeen)}</small></div>
                <span>{group.members.map((member) => member.name ?? member.characterId).join(' · ')}</span>
              </article>
            ))}
          </div>
        )}
      </section>

      <p className="data-boundary-note">
        These links come only from the available public killmail sample. A joint fight does not prove
        permanent membership in one gang.
        {intelligence.sample.attackersMayBeIncomplete && ' Some killmails have truncated participant lists.'}
      </p>
    </div>
  )
}

function CorporationDossierPanel({
  dossier,
  onOpenPilot
}: {
  dossier: CorporationDossier | null
  onOpenPilot?: OpenPilotWorkspace
}): React.JSX.Element {
  if (!dossier) {
    return (
      <div className="history-empty">
        <strong>Corporation unknown</strong>
        <p>ESI/killboard has no organization to build a sample from.</p>
      </div>
    )
  }
  if (dossier.sample.killmailsInvolvingCorporation === 0) {
    return (
      <div className="history-empty">
        <strong>No corporation activity found</strong>
        <p>The loaded pilot killmails do not contain a sufficient corporation sample.</p>
      </div>
    )
  }

  return (
    <div className="behavior-intel-panel corporation-dossier">
      <div className="behavior-summary">
        <span><b>{dossier.observedPilots.length}</b> observed pilots</span>
        <span><b>{dossier.activity.attackKillmails}</b> attacks</span>
        <span><b>{dossier.activity.lossKillmails}</b> losses</span>
        <span><b>{formatIsk(dossier.activity.iskDestroyed)}</b> destroyed</span>
      </div>

      <section className="behavior-section">
        <div className="section-heading compact">
          <div><p className="eyebrow">{dossier.corporationName ?? dossier.corporationId}</p><h3>Observed pilots</h3></div>
        </div>
        <div className="behavior-pilot-grid">
          {dossier.observedPilots.map((observed) => (
            <button
              type="button"
              className="behavior-pilot-card"
              key={observed.characterId}
              disabled={!onOpenPilot}
              onClick={() => onOpenPilot?.({
                characterId: observed.characterId,
                name: observed.name,
                sourceLabel: `Corporation · ${dossier.corporationName ?? dossier.corporationId}`
              })}
            >
              <span className="behavior-pilot-title">
                <strong>{observed.name ?? `Pilot ${observed.characterId}`}</strong>
                <b>{observed.attackKillmails + observed.losses}×</b>
              </span>
              <small>Attacks: {observed.attackKillmails} · losses: {observed.losses} · final: {observed.finalBlows}</small>
              <span className="behavior-tags">
                {observed.ships.slice(0, 4).map((ship) => (
                  <i key={`${ship.typeId}-${ship.name}`}>{ship.name ?? ship.typeId ?? 'ship'} ×{ship.count}</i>
                ))}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="behavior-section">
        <div className="section-heading compact">
          <div><p className="eyebrow">Hulls in sample</p><h3>Frequently observed ships</h3></div>
        </div>
        <div className="corporation-ship-grid">
          {dossier.observedShips.slice(0, 20).map((ship) => (
            <article key={ship.typeId}>
              <EveTypeImage typeId={ship.typeId} variant="icon" requestSize={64} />
              <div><strong>{ship.name ?? `Type ${ship.typeId}`}</strong><small>attacks {ship.attackerObservations} · losses {ship.lossObservations}</small></div>
              <b>{ship.totalObservations}×</b>
            </article>
          ))}
        </div>
      </section>

      <p className="data-boundary-note">{dossier.provenance.statement}</p>
    </div>
  )
}

function toggleNumberSet(current: ReadonlySet<number>, key: number): Set<number> {
  const next = new Set(current)
  if (!next.delete(key)) next.add(key)
  return next
}

function fallbackHistoricalPilot(characterId: number, name: string | null): PilotIntel {
  return {
    id: characterId,
    name: name ?? `Pilot ${characterId}`,
    corporationId: null,
    corporationName: null,
    allianceId: null,
    allianceName: null,
    factionId: null,
    stats: null,
    threatScore: 0,
    threatLevel: 'unknown',
    reasons: [],
    zkillUrl: `https://zkillboard.com/character/${characterId}/`,
    cached: false,
    error: null
  }
}

export function LastObservedPilotShipCard({
  historyState
}: {
  historyState: PilotHistoryState
}): React.JSX.Element {
  const observation = useMemo(
    () => selectLastObservedPilotShip(historyState.data),
    [historyState.data]
  )

  if (!observation) {
    const loading = historyState.status === 'idle' || historyState.status === 'loading'
    const failed = historyState.status === 'error'
    const entryCount = (historyState.data?.kills.length ?? 0) +
      (historyState.data?.losses.length ?? 0)
    const partial = (historyState.data?.warnings.length ?? 0) > 0
    const heading = loading
      ? 'Finding latest hull in killmails…'
      : failed
        ? 'Could not determine from killboard'
        : partial && entryCount === 0
          ? 'Source returned incomplete history'
          : entryCount === 0
            ? 'No public killmails found'
            : 'Pilot hull not listed'
    const detail = failed
      ? historyState.error ?? 'Killmail history is currently unavailable.'
      : loading
        ? 'This card will appear as soon as history loads.'
        : partial && entryCount === 0
          ? 'Part of the killboard is currently unavailable, so the latest hull cannot be determined.'
          : entryCount === 0
            ? 'The available history window has no public kills or losses for this pilot.'
            : 'Killmails were found, but none list this pilot’s exact hull.'

    return (
      <section
        className={`last-observed-ship-card empty ${loading ? 'loading' : ''} ${failed ? 'error' : ''}`}
        aria-label="Latest observed ship"
        aria-live={failed ? 'assertive' : 'polite'}
        role={failed ? 'alert' : 'status'}
      >
        <div className="last-observed-ship-placeholder" aria-hidden="true">⌁</div>
        <div className="last-observed-ship-copy">
          <p>Latest observed ship</p>
          <strong>{heading}</strong>
          <small>{detail}</small>
        </div>
      </section>
    )
  }

  const shipName = observation.shipName ?? `Ship type ${observation.typeId}`
  const systemName = observation.solarSystemName ?? `System ${observation.solarSystemId}`
  const roleLabel = observation.role === 'attacker'
    ? 'Pilot attacked in it'
    : 'Pilot lost this ship'

  return (
    <section
      className={`last-observed-ship-card ${historyState.data?.warnings.length ? 'partial' : ''}`}
      aria-label={`Latest observed ship: ${shipName}`}
      aria-live="polite"
      role="status"
    >
      <EveTypeImage
        typeId={observation.typeId}
        variant="render"
        requestSize={256}
        className="last-observed-ship-image"
      />
      <div className="last-observed-ship-copy">
        <p>Latest observed ship</p>
        <div className="last-observed-ship-name">
          <strong>{shipName}</strong>
          <span className={observation.role}>{roleLabel}</span>
          {!!historyState.data?.warnings.length && (
            <span className="partial">Incomplete history</span>
          )}
        </div>
        <small>
          {historyState.data?.warnings.length
            ? 'Latest hull among loaded killmails; part of history is currently unavailable.'
            : 'A historical public killmail observation is not the pilot’s current ship.'}
        </small>
      </div>
      <div className="last-observed-ship-event">
        <strong>{systemName}</strong>
        <span>{formatCombatDate(observation.time)}</span>
        <small>Killmail #{observation.killmailId}</small>
      </div>
    </section>
  )
}

function HistoricalPilotDetails({
  api,
  characterId,
  name,
  instanceId,
  initialPilot,
  watchlisted = false,
  watchlistPending = false,
  onToggleWatchlist,
  onOpenPilot
}: {
  api: EveLocalIntelApi | null
  characterId: number
  name: string | null
  instanceId: string
  initialPilot?: PilotIntel
  watchlisted?: boolean
  watchlistPending?: boolean
  onToggleWatchlist?: (pilot: PilotFavoriteCandidate) => void
  onOpenPilot?: OpenPilotWorkspace
}): React.JSX.Element {
  const suppliedPilot = initialPilot?.id === characterId ? initialPilot : null
  const [pilot, setPilot] = useState<PilotIntel>(
    () => suppliedPilot ?? fallbackHistoricalPilot(characterId, name)
  )
  const [pilotLoading, setPilotLoading] = useState(suppliedPilot === null)
  const [pilotError, setPilotError] = useState<string | null>(null)
  const [historyState, setHistoryState] = useState<PilotHistoryState>({ status: 'idle' })
  const [loadMoreState, setLoadMoreState] = useState<
    Record<CombatHistoryKind, HistoryLoadMoreState>
  >({ kill: { status: 'idle' }, loss: { status: 'idle' } })
  const [tab, setTab] = useState<DetailsTab>('profile')
  const [expandedKillmailId, setExpandedKillmailId] = useState<number | null>(null)
  const pilotRequestVersionRef = useRef(0)
  const historyRequestVersionRef = useRef(0)
  const loadMoreRequestVersionRef = useRef<Record<CombatHistoryKind, number>>({
    kill: 0,
    loss: 0
  })

  const loadPilot = useCallback(async (forceRefresh = false): Promise<void> => {
    const requestVersion = pilotRequestVersionRef.current + 1
    pilotRequestVersionRef.current = requestVersion
    if (!api) {
      setPilotLoading(false)
      setPilotError('Desktop app bridge unavailable')
      return
    }

    setPilotLoading(true)
    setPilotError(null)
    try {
      const result = await api.getPilotIntel({ characterId, forceRefresh })
      if (pilotRequestVersionRef.current !== requestVersion) return
      setPilot(result)
    } catch (caught) {
      if (pilotRequestVersionRef.current !== requestVersion) return
      setPilot(fallbackHistoricalPilot(characterId, name))
      setPilotError(errorMessage(caught))
    } finally {
      if (pilotRequestVersionRef.current === requestVersion) setPilotLoading(false)
    }
  }, [api, characterId, name])

  const loadHistory = useCallback(async (forceRefresh = false): Promise<void> => {
    const requestVersion = historyRequestVersionRef.current + 1
    historyRequestVersionRef.current = requestVersion
    loadMoreRequestVersionRef.current.kill += 1
    loadMoreRequestVersionRef.current.loss += 1
    setLoadMoreState({ kill: { status: 'idle' }, loss: { status: 'idle' } })
    if (!api) {
      setHistoryState({ status: 'error', error: 'Killboard history unavailable' })
      return
    }

    setHistoryState((current) => ({ status: 'loading', data: current.data }))
    try {
      const history = await api.getCombatHistory({ characterId, limit: 10, forceRefresh })
      if (historyRequestVersionRef.current !== requestVersion) return
      setHistoryState({ status: 'ready', data: history })
    } catch (caught) {
      if (historyRequestVersionRef.current !== requestVersion) return
      setHistoryState({ status: 'error', error: errorMessage(caught) })
    }
  }, [api, characterId])

  const loadMoreHistory = useCallback(async (
    kind: CombatHistoryKind,
    offset: number
  ): Promise<void> => {
    const requestVersion = loadMoreRequestVersionRef.current[kind] + 1
    loadMoreRequestVersionRef.current[kind] = requestVersion
    if (!api) {
      setLoadMoreState((current) => ({
        ...current,
        [kind]: { status: 'error', error: 'Killboard history unavailable' }
      }))
      return
    }

    setLoadMoreState((current) => ({
      ...current,
      [kind]: { status: 'loading' }
    }))
    try {
      const page = await api.getCombatHistory({
        characterId,
        kind,
        offset,
        limit: 50,
        forceRefresh: false
      })
      if (loadMoreRequestVersionRef.current[kind] !== requestVersion) return
      setHistoryState((current) => current.data
        ? { status: 'ready', data: mergeCombatHistoryPage(current.data, page, kind) }
        : current)
      setLoadMoreState((current) => ({
        ...current,
        [kind]: { status: 'idle' }
      }))
    } catch (caught) {
      if (loadMoreRequestVersionRef.current[kind] !== requestVersion) return
      setLoadMoreState((current) => ({
        ...current,
        [kind]: { status: 'error', error: errorMessage(caught) }
      }))
    }
  }, [api, characterId])

  useEffect(() => {
    setPilot(suppliedPilot ?? fallbackHistoricalPilot(characterId, name))
    setPilotLoading(suppliedPilot === null)
    setPilotError(null)
    setHistoryState({ status: 'idle' })
    setLoadMoreState({ kill: { status: 'idle' }, loss: { status: 'idle' } })
    setTab('profile')
    setExpandedKillmailId(null)
    if (suppliedPilot === null) void loadPilot()
    void loadHistory()
    return () => {
      pilotRequestVersionRef.current += 1
      historyRequestVersionRef.current += 1
      loadMoreRequestVersionRef.current.kill += 1
      loadMoreRequestVersionRef.current.loss += 1
    }
  }, [characterId, loadHistory, loadPilot, name, suppliedPilot])

  const changeTab = (nextTab: DetailsTab): void => {
    setTab(nextTab)
    if (
      nextTab !== 'profile' &&
      historyState.status !== 'loading' &&
      historyState.status !== 'ready'
    ) {
      void loadHistory()
    }
  }

  return (
    <div className="historical-pilot-details">
      <div className="historical-pilot-summary">
        <div>
          <span>Killboard profile</span>
          <strong>{pilot.name}</strong>
          <small>
            {[pilot.corporationName, pilot.allianceName].filter(Boolean).join(' · ') ||
              (pilotLoading ? 'Loading corporation and statistics…' : 'Organization unknown')}
          </small>
        </div>
        <div className="historical-pilot-stats">
          {onToggleWatchlist && (
            name !== null ||
            suppliedPilot !== null ||
            (!pilotLoading && pilotError === null)
          ) && (
            <PilotFavoriteButton
              pilot={{
                characterId: pilot.id,
                name: pilot.name,
                corporationName: pilot.corporationName
              }}
              favorite={watchlisted}
              pending={watchlistPending}
              onToggle={onToggleWatchlist}
              className="pilot-profile-favorite"
            />
          )}
          <span>Kills <b>{pilot.stats?.shipsDestroyed ?? '—'}</b></span>
          <span>Losses <b>{pilot.stats?.shipsLost ?? '—'}</b></span>
          <span className={`history-threat ${pilot.threatLevel}`}>
            {THREAT_LABELS[pilot.threatLevel]}
          </span>
        </div>
      </div>
      <LastObservedPilotShipCard historyState={historyState} />
      {pilotError && (
        <p className="history-warning">
          Profile loaded partially: {pilotError}. Combat history is checked separately.
        </p>
      )}
      {!pilotError && pilot.stats === null && historyState.status === 'ready' && (
        <p className="history-warning">
          No separate killboard profile found. This can happen for NPCs/Drifters; using available
          killmail history.
        </p>
      )}
      <PilotDetailsPanel
        pilot={pilot}
        tab={tab}
        historyState={historyState}
        loadMoreState={loadMoreState}
        expandedKillmailId={expandedKillmailId}
        instanceId={instanceId}
        onTabChange={changeTab}
        onRetry={() => void (tab === 'profile' ? loadPilot(true) : loadHistory(true))}
        onLoadMore={(kind) => {
          if (loadMoreState[kind].status === 'loading') return
          const pageInfo = historyState.data?.pageInfo[kind]
          if (!pageInfo?.hasMore) return
          void loadMoreHistory(kind, pageInfo.nextOffset)
        }}
        onToggleKillmail={(killmailId) => {
          setExpandedKillmailId((current) => current === killmailId ? null : killmailId)
        }}
        onOpenPilot={onOpenPilot}
      />
    </div>
  )
}

export function PilotWorkspacePanel({
  api,
  selection,
  onBack,
  onClose,
  watchlisted = false,
  watchlistPending = false,
  onToggleWatchlist,
  onOpenPilot
}: {
  api: EveLocalIntelApi | null
  selection: PilotWorkspaceSelection
  onBack: () => void
  onClose: () => void
  watchlisted?: boolean
  watchlistPending?: boolean
  onToggleWatchlist?: (pilot: PilotFavoriteCandidate) => void
  onOpenPilot?: OpenPilotWorkspace
}): React.JSX.Element {
  const pilotName = selection.name ?? `Pilot ${selection.characterId}`
  const backLabel = selection.sourceLabel === 'Watchlist'
    ? 'Back to contacts'
    : 'Back to intel'

  return (
    <section className="pilot-workspace-panel" aria-labelledby="pilot-workspace-title">
      <header className="pilot-workspace-heading">
        <button type="button" className="pilot-workspace-back" onClick={onBack}>
          <span aria-hidden="true">←</span>
          {backLabel}
        </button>
        <div>
          <p className="eyebrow">Full pilot card · {selection.sourceLabel}</p>
          <h1 id="pilot-workspace-title">{pilotName}</h1>
          <small>Target profile, recent kills, losses, and fits without nested cards</small>
        </div>
        <button type="button" className="pilot-workspace-close" onClick={onClose}>
          Close tab
        </button>
      </header>

      <HistoricalPilotDetails
        api={api}
        characterId={selection.characterId}
        name={selection.name}
        initialPilot={selection.initialPilot}
        watchlisted={watchlisted}
        watchlistPending={watchlistPending}
        onToggleWatchlist={onToggleWatchlist}
        onOpenPilot={onOpenPilot}
        instanceId={`workspace-${selection.characterId}`}
      />
    </section>
  )
}

function formatKillmailOffset(offsetMs: number): string {
  const absoluteMinutes = Math.max(0, Math.round(Math.abs(offsetMs) / 60_000))
  if (absoluteMinutes === 0) return 'at the minute D-scan was copied'
  const duration = absoluteMinutes < 60
    ? `${absoluteMinutes} min`
    : `${Math.floor(absoluteMinutes / 60)} h ${absoluteMinutes % 60} min`
  return offsetMs < 0 ? `${duration} before D-scan` : `${duration} after D-scan`
}

function candidateEvidenceText(candidate: DscanPilotCandidate): string {
  const victim = candidate.victimName ?? candidate.victimShipName ?? 'unknown target'
  const targetShip = candidate.victimName && candidate.victimShipName
    ? ` in ${candidate.victimShipName}`
    : ''
  return [
    `Killmail #${candidate.killmailId}`,
    formatCombatDate(candidate.evidenceAt),
    formatKillmailOffset(candidate.timeOffsetMs),
    `target: ${victim}${targetShip}`,
    candidate.finalBlow ? 'FINAL' : null,
    candidate.matchingKillmailCount > 1
      ? `pilot matches in window: ${candidate.matchingKillmailCount}`
      : null
  ].filter(Boolean).join(' · ')
}

function observedShipOccurrenceText(occurrence: SystemObservedShipOccurrence): string {
  if (occurrence.role === 'victim') return 'lost this hull'
  const victim = occurrence.victimName ?? occurrence.victimShipName ?? 'unknown target'
  const targetShip = occurrence.victimName && occurrence.victimShipName
    ? ` in ${occurrence.victimShipName}`
    : ''
  return `attacked: ${victim}${targetShip}${occurrence.finalBlow ? ' · FINAL' : ''}`
}

const DSCAN_MATCH_STRENGTH_LABELS = {
  strong: '≤ 15 min · one pilot',
  medium: '≤ 2 h',
  weak: '≤ 6 h'
} as const

export function DscanKillboardCorrelationPanel({
  snapshot,
  currentSystem,
  onOpenPilot,
  watchlistById,
  watchlistPendingEntityKeys,
  onToggleWatchlist,
  onCandidatesObserved
}: {
  snapshot: Extract<TacticalClipboardSnapshot, { kind: 'dscan' }>
  currentSystem: CurrentSystemSnapshot | null
  onOpenPilot: OpenPilotWorkspace
  watchlistById?: ReadonlyMap<number, PilotWatchlistEntry>
  watchlistPendingEntityKeys?: ReadonlySet<PilotWatchlistEntityKey>
  onToggleWatchlist?: (pilot: PilotFavoriteCandidate) => void
  onCandidatesObserved?: (candidates: readonly DscanPilotCandidate[]) => void
}): React.JSX.Element {
  const announcedCandidatesRef = useRef({
    capturedAt: null as string | null,
    characterIds: [] as number[]
  })
  const currentSystemId = currentSystem?.intel?.system.id ?? null
  const correlation = useMemo(() => correlateDscanPilots(
    snapshot.intelligence.composition.hulls,
    currentSystem?.intel?.zkill24h,
    {
      capturedSystemId: snapshot.solarSystemId,
      historySystemId: currentSystemId,
      capturedAt: snapshot.capturedAt
    }
  ), [
    currentSystem?.intel?.zkill24h,
    currentSystemId,
    snapshot.capturedAt,
    snapshot.intelligence,
    snapshot.solarSystemId
  ])

  useEffect(() => {
    if (!onCandidatesObserved) return
    const strongCandidates = [...new Map(correlation.matches
      .flatMap((match) => match.candidates)
      .filter((candidate) => candidate.strength === 'strong')
      .map((candidate) => [candidate.characterId, candidate])).values()]
    const delta = reconcilePilotWatchlistDscanCandidates(
      announcedCandidatesRef.current,
      snapshot.capturedAt,
      strongCandidates.map((candidate) => candidate.characterId)
    )
    announcedCandidatesRef.current = delta.state
    const newlyObservedIds = new Set(delta.newCharacterIds)
    const newlyObserved = strongCandidates.filter((candidate) => (
      newlyObservedIds.has(candidate.characterId)
    ))
    if (newlyObserved.length === 0) return
    onCandidatesObserved(newlyObserved)
  }, [correlation.matches, onCandidatesObserved, snapshot.capturedAt])

  const statusCopy = correlation.status === 'no-system'
    ? 'D-scan system unknown — sign in or refresh your location.'
    : correlation.status === 'system-changed'
      ? 'You changed systems after this D-scan. Older candidates are not used.'
      : correlation.status === 'no-history'
        ? 'System killboard history has not loaded yet.'
        : null

  return (
    <section className="dscan-killboard-panel" aria-labelledby="dscan-killboard-title">
      <div className="dscan-killboard-heading">
        <div>
          <p className="eyebrow">D-scan ↔ killboard · hull + system + time</p>
          <h2 id="dscan-killboard-title">Killmails near D-scan</h2>
        </div>
        <span>{correlation.matches.length}</span>
      </div>

      {statusCopy ? (
        <p className="dscan-match-empty">{statusCopy}</p>
      ) : correlation.matches.length === 0 ? (
        <p className="dscan-match-empty">
          {correlation.incomplete
            ? 'No matches found in the available incomplete killboard sample.'
            : 'No killmails within six hours of D-scan where a pilot attacked in this hull.'}
        </p>
      ) : (
        <div className="dscan-match-list">
          {correlation.matches.map((match) => (
            <article className="dscan-match-hull" key={match.dscanKey}>
              <div className="dscan-match-hull-heading">
                {match.typeId !== null && (
                  <EveTypeImage
                    typeId={match.typeId}
                    variant="icon"
                    requestSize={64}
                    className="dscan-match-ship-image"
                  />
                )}
                <div>
                  <strong>{match.historyShipName ?? match.typeName ?? 'Unknown hull'}</strong>
                  <small>
                    D-scan ×{match.dscanCount} · time-near pilots {match.candidates.length}
                    {match.candidatesCapped && '+'}
                  </small>
                </div>
              </div>
              <div className="dscan-candidate-list">
                {match.candidates.map((candidate) => {
                  const key = `${match.dscanKey}:${candidate.characterId}`
                  return (
                    <div className="dscan-candidate" key={key}>
                      <button
                        type="button"
                        className="dscan-candidate-toggle"
                        aria-label={`Open full pilot card for ${candidate.name ?? candidate.characterId}`}
                        onClick={() => onOpenPilot({
                          characterId: candidate.characterId,
                          name: candidate.name,
                          sourceLabel: `D-scan · ${match.historyShipName ?? match.typeName ?? 'hull'} · Killmail #${candidate.killmailId}`
                        })}
                      >
                        <span className={`candidate-strength ${candidate.strength}`}>
                          {DSCAN_MATCH_STRENGTH_LABELS[candidate.strength]}
                        </span>
                        <strong>{candidate.name ?? `Pilot ${candidate.characterId}`}</strong>
                        <small>{candidateEvidenceText(candidate)}</small>
                        <b aria-hidden="true">›</b>
                      </button>
                      {onToggleWatchlist && candidate.name && (
                        <PilotFavoriteButton
                          pilot={{
                            characterId: candidate.characterId,
                            name: candidate.name
                          }}
                          favorite={watchlistById?.has(candidate.characterId) ?? false}
                          pending={watchlistPendingEntityKeys?.has(
                            toPilotWatchlistEntityKey('character', candidate.characterId)
                          ) ?? false}
                          onToggle={onToggleWatchlist}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            </article>
          ))}
        </div>
      )}

      <p className="dscan-match-disclaimer">
        Exact hull, system, and D-scan copy time are compared. Victims are not candidates because
        their ships were already destroyed. Even a nearby killmail does not confirm a pilot’s identity.
        {correlation.unmatchedHullCount > 0 && ` Unmatched: ${correlation.unmatchedHullCount} types.`}
        {correlation.incomplete && ' Source sample incomplete.'}
      </p>
    </section>
  )
}

function formatSystemMetric(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-US')
}

function formatSampleCount(value: number, incomplete: boolean): string {
  return `${value.toLocaleString('en-US')}${incomplete ? '+' : ''}`
}

function formatSecurityStatus(value: number): string {
  return value.toFixed(2).replace('.', ',')
}

function SystemIntelPanel({
  api,
  onSnapshotChange,
  pollingActive,
  onOpenPilot,
  watchlistById,
  watchlistPendingEntityKeys,
  onToggleWatchlist,
  currentSystemPollIntervalMs = CURRENT_SYSTEM_POLL_INTERVAL_MS,
  pilotContextPollIntervalMs = PILOT_CONTEXT_POLL_INTERVAL_MS,
  pollInBackground = false,
  onKillAlertsObserved,
  onPilotContextChange,
  additionalKillAlertSystemIds = EMPTY_SYSTEM_IDS
}: {
  api: EveLocalIntelApi | null
  onSnapshotChange: (snapshot: CurrentSystemSnapshot | null) => void
  pollingActive: boolean
  onOpenPilot: OpenPilotWorkspace
  watchlistById: ReadonlyMap<number, PilotWatchlistEntry>
  watchlistPendingEntityKeys: ReadonlySet<PilotWatchlistEntityKey>
  onToggleWatchlist: (pilot: PilotFavoriteCandidate) => void
  currentSystemPollIntervalMs?: number
  pilotContextPollIntervalMs?: number
  pollInBackground?: boolean
  onKillAlertsObserved?: (alerts: readonly KillAlert[]) => void
  onPilotContextChange?: (context: PilotContext | null) => void
  additionalKillAlertSystemIds?: readonly number[]
}): React.JSX.Element {
  const supportsAccount = Boolean(
    api &&
      typeof api.getAccountStatus === 'function' &&
      typeof api.connectAccount === 'function' &&
      typeof api.disconnectAccount === 'function' &&
      typeof api.getCurrentSystem === 'function'
  )
  const [account, setAccount] = useState<EveAccountStatus | null>(null)
  const [snapshot, setSnapshot] = useState<CurrentSystemSnapshot | null>(null)
  const [isStatusLoading, setIsStatusLoading] = useState(supportsAccount)
  const [accountAction, setAccountAction] = useState<'connect' | 'disconnect' | null>(null)
  const [isSystemRefreshing, setIsSystemRefreshing] = useState(false)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [systemNotice, setSystemNotice] = useState<string | null>(null)
  const [pilotContext, setPilotContext] = useState<PilotContext | null>(null)
  const [pilotStatus, setPilotStatus] = useState<OperationalPanelStatus>({ state: 'idle' })
  const [killAlerts, setKillAlerts] = useState<KillAlert[]>([])
  const [killAlertStatus, setKillAlertStatus] = useState<OperationalPanelStatus>({ state: 'idle' })
  const [showAllObservedShips, setShowAllObservedShips] = useState(false)
  const [showAllObservedPilots, setShowAllObservedPilots] = useState(false)
  const [expandedObservedShips, setExpandedObservedShips] = useState<ReadonlySet<number>>(
    () => new Set<number>()
  )
  const [showAllObservedShipOccurrences, setShowAllObservedShipOccurrences] = useState<ReadonlySet<number>>(
    () => new Set<number>()
  )
  const systemRequestInFlightRef = useRef(false)
  const snapshotRef = useRef<CurrentSystemSnapshot | null>(null)
  const contextRequestInFlightRef = useRef(false)
  const requestVersionRef = useRef(0)
  const mountedRef = useRef(true)
  const currentSolarSystemId = snapshot?.online === true
    ? snapshot.intel?.system.id ?? null
    : null

  useEffect(() => {
    setExpandedObservedShips(new Set<number>())
    setShowAllObservedShipOccurrences(new Set<number>())
    setShowAllObservedShips(false)
    setShowAllObservedPilots(false)
  }, [currentSolarSystemId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refreshSystem = useCallback(
    async (showProgress = false): Promise<void> => {
      if (!api || !supportsAccount || systemRequestInFlightRef.current) return
      systemRequestInFlightRef.current = true
      const requestVersion = requestVersionRef.current
      if (showProgress) setIsSystemRefreshing(true)

      try {
        const nextSnapshot = await api.getCurrentSystem()
        if (!mountedRef.current || requestVersion !== requestVersionRef.current) return
        const reconciled = reconcileCurrentSystemSnapshot(snapshotRef.current, nextSnapshot)
        snapshotRef.current = reconciled.snapshot
        setSnapshot(reconciled.snapshot)
        onSnapshotChange(reconciled.snapshot)
        setAccount(nextSnapshot.account)
        setPanelError(null)
        setSystemNotice(reconciled.retainedPrevious
          ? `${ESI_RATE_LIMIT_MESSAGE} Showing last successful data.`
          : null)
      } catch (caught) {
        if (mountedRef.current && requestVersion === requestVersionRef.current) {
          const message = errorMessage(caught)
          if (snapshotRef.current !== null) {
            setPanelError(null)
            setSystemNotice(isEsiRateLimitMessage(message)
              ? `${ESI_RATE_LIMIT_MESSAGE} Showing last successful data.`
              : 'Could not refresh data. Showing last successful snapshot; will retry automatically.')
          } else {
            setPanelError(`System did not refresh: ${message}`)
          }
        }
      } finally {
        systemRequestInFlightRef.current = false
        if (mountedRef.current && showProgress) setIsSystemRefreshing(false)
      }
    },
    [api, onSnapshotChange, supportsAccount]
  )

  const refreshPilotContext = useCallback(
    async (forceRefresh = false): Promise<void> => {
      if (
        !api ||
        typeof api.getPilotContext !== 'function' ||
        contextRequestInFlightRef.current
      ) return

      contextRequestInFlightRef.current = true
      const requestVersion = requestVersionRef.current
      setPilotStatus((current) => current.state === 'ready'
        ? { ...current, message: 'Refreshing ESI…' }
        : { state: 'loading', connected: true })

      try {
        const nextContext = await api.getPilotContext({ forceRefresh })
        if (!mountedRef.current || requestVersion !== requestVersionRef.current) return
        const sanitizedContext = nextContext === null
          ? null
          : {
              ...nextContext,
              warnings: nextContext.warnings.map(sanitizeEsiMessage)
            }
        setPilotContext(sanitizedContext)
        onPilotContextChange?.(sanitizedContext)
        setPilotStatus(sanitizedContext
          ? {
              state: 'ready',
              connected: true,
              message: null,
              warnings: sanitizedContext.warnings
            }
          : {
              state: 'idle',
              connected: false,
              message: 'Sign in with a character to load contacts and friendly fleet.'
            })
      } catch (caught) {
        if (mountedRef.current && requestVersion === requestVersionRef.current) {
          setPilotStatus({
            state: 'error',
            connected: false,
            message: `Pilot Context unavailable: ${sanitizeEsiMessage(errorMessage(caught))}`
          })
        }
      } finally {
        contextRequestInFlightRef.current = false
      }
    },
    [api, onPilotContextChange]
  )

  useEffect(() => {
    if (!api || !supportsAccount) {
      setIsStatusLoading(false)
      return
    }

    let active = true
    setIsStatusLoading(true)
    void api
      .getAccountStatus()
      .then((nextAccount) => {
        if (!active) return
        setAccount(nextAccount)
        setPanelError(nextAccount.error === null ? null : sanitizeEsiMessage(nextAccount.error))
        if (nextAccount.connected) {
          void refreshSystem()
          void refreshPilotContext()
        }
      })
      .catch((caught) => {
        if (active) setPanelError(`EVE SSO unavailable: ${errorMessage(caught)}`)
      })
      .finally(() => {
        if (active) setIsStatusLoading(false)
      })

    return () => {
      active = false
    }
  }, [api, refreshPilotContext, refreshSystem, supportsAccount])

  useEffect(() => {
    if (!account?.connected) {
      return
    }
    if (!pollingActive) return

    // Account bootstrap/connect already perform the first refresh. Recreating
    // schedulers after a settings-slider change must not create an ESI burst.
    const pollImmediately = false

    const clock = {
      setTimeout: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
      clearTimeout: (handle: number) => window.clearTimeout(handle)
    }
    const visibility = {
      isVisible: () => pollInBackground || !document.hidden,
      subscribe: (listener: () => void) => {
        if (pollInBackground) return () => undefined
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      }
    }
    const stopSystemPolling = startCurrentSystemPolling({
      poll: () => refreshSystem(),
      clock,
      visibility,
      intervalMs: currentSystemPollIntervalMs,
      pollImmediately
    })
    const stopPilotContextPolling = startCurrentSystemPolling({
      poll: () => refreshPilotContext(),
      clock,
      visibility,
      intervalMs: pilotContextPollIntervalMs,
      pollImmediately
    })

    return () => {
      stopSystemPolling()
      stopPilotContextPolling()
    }
  }, [
    account?.connected,
    currentSystemPollIntervalMs,
    pilotContextPollIntervalMs,
    pollInBackground,
    pollingActive,
    refreshPilotContext,
    refreshSystem
  ])

  useEffect(() => {
    const solarSystemId = currentSolarSystemId
    const monitoredSystemIds = [
      solarSystemId,
      ...additionalKillAlertSystemIds.filter((systemId) => systemId !== solarSystemId)
    ].filter((systemId): systemId is number => (
      typeof systemId === 'number' && Number.isSafeInteger(systemId) && systemId > 0
    ))
      .slice(0, 256)
    if (
      !api ||
      typeof api.pollKillAlerts !== 'function' ||
      !account?.connected ||
      solarSystemId === null
    ) {
      setKillAlerts([])
      setKillAlertStatus({
        state: 'idle',
        connected: false,
        message: 'Kill alerts start when ESI identifies the current system.'
      })
      return
    }

    let active = true
    let inFlight = false
    let timer: number | null = null
    setKillAlerts([])
    setKillAlertStatus({
      state: 'loading',
      connected: false,
      message: 'Connecting to R2Z2…'
    })

    const poll = async (): Promise<void> => {
      if (!active || inFlight || (!pollInBackground && document.hidden)) return
      inFlight = true
      try {
        const response = await api.pollKillAlerts({
          systemIds: monitoredSystemIds,
          currentSystemId: solarSystemId,
          maxEvents: 25
        })
        if (!active) return

        if (response.alerts.length > 0) onKillAlertsObserved?.(response.alerts)

        if (response.alerts.length > 0) {
          setKillAlerts((current) => {
            const byKillmail = new Map<number, KillAlert>()
            for (const alert of [...response.alerts, ...current]) {
              if (!byKillmail.has(alert.killmailId)) byKillmail.set(alert.killmailId, alert)
            }
            return [...byKillmail.values()]
              .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
              .slice(0, 100)
          })
        }

        setKillAlertStatus({
          state: response.connected ? 'ready' : 'error',
          connected: response.connected,
          message: response.connected
            ? 'Waiting for new received killmails in the current system.'
            : 'R2Z2 is temporarily unavailable; will retry automatically.',
          warnings: response.warnings
        })

        const delay = normalizeKillAlertPollDelay(response.nextPollMs)
        if (pollInBackground || !document.hidden) {
          timer = window.setTimeout(() => {
            timer = null
            void poll()
          }, delay)
        }
      } catch (caught) {
        if (!active) return
        setKillAlertStatus({
          state: 'error',
          connected: false,
          message: `R2Z2 unavailable: ${errorMessage(caught)}`
        })
        if (pollInBackground || !document.hidden) {
          timer = window.setTimeout(() => {
            timer = null
            void poll()
          }, 10_000)
        }
      } finally {
        inFlight = false
      }
    }

    const handleVisibilityChange = (): void => {
      if (!active || pollInBackground || document.hidden || timer !== null || inFlight) return
      void poll()
    }
    if (!pollInBackground) document.addEventListener('visibilitychange', handleVisibilityChange)
    void poll()
    return () => {
      active = false
      if (!pollInBackground) {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [
    account?.connected,
    additionalKillAlertSystemIds,
    api,
    currentSolarSystemId,
    onKillAlertsObserved,
    pollInBackground
  ])

  const handleConnect = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!api || !supportsAccount || accountAction) return
    requestVersionRef.current += 1
    setAccountAction('connect')
    setPanelError(null)
    try {
      await api.connectAccount()
      const nextAccount = await api.getAccountStatus()
      setAccount(nextAccount)
      setPanelError(nextAccount.error === null ? null : sanitizeEsiMessage(nextAccount.error))
      if (nextAccount.connected) {
        await Promise.all([refreshSystem(true), refreshPilotContext(true)])
      }
    } catch (caught) {
      setPanelError(`Sign-in did not finish: ${errorMessage(caught)}`)
    } finally {
      if (mountedRef.current) setAccountAction(null)
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    if (!api || !supportsAccount || accountAction) return
    requestVersionRef.current += 1
    setAccountAction('disconnect')
    setPanelError(null)
    try {
      await api.disconnectAccount()
      const nextAccount = await api.getAccountStatus()
      setAccount(nextAccount)
      snapshotRef.current = null
      setSnapshot(null)
      onSnapshotChange(null)
      setPilotContext(null)
      setPilotStatus({ state: 'idle', connected: false })
      setKillAlerts([])
      setKillAlertStatus({ state: 'idle', connected: false })
      setSystemNotice(null)
      setPanelError(nextAccount.error === null ? null : sanitizeEsiMessage(nextAccount.error))
    } catch (caught) {
      setPanelError(`Could not disconnect EVE SSO: ${errorMessage(caught)}`)
    } finally {
      if (mountedRef.current) setAccountAction(null)
    }
  }

  const intel = snapshot?.intel ?? null
  const callbackUri = account?.callbackUri ?? EVE_SSO_CALLBACK_FALLBACK
  const warnings = Array.from(
    new Set([...(snapshot?.warnings ?? []), ...(intel?.warnings ?? [])].map(sanitizeEsiMessage))
  )
  const accountError = account?.error === null || account?.error === undefined
    ? null
    : sanitizeEsiMessage(account.error)
  const observedShips = intel?.zkill24h.observedShips ?? []
  const observedPilots = intel?.zkill24h.observedPilots ?? []
  const sourceCapped = intel?.zkill24h.sourceCapped ?? false
  const observedShipsIncomplete = sourceCapped || (intel?.zkill24h.observedShipsCapped ?? false)
  const observedPilotsIncomplete = sourceCapped || (intel?.zkill24h.observedPilotsCapped ?? false)
  const visibleObservedShips = showAllObservedShips ? observedShips : observedShips.slice(0, 9)
  const visibleObservedPilots = showAllObservedPilots ? observedPilots : observedPilots.slice(0, 10)

  return (
    <section
      className={`system-intel-panel ${account?.connected ? 'connected-layout' : ''}`}
      aria-labelledby="system-intel-title"
    >
      <div className="system-intel-heading">
        <div>
          <p className="eyebrow">
            EVE SSO · location polled every {CURRENT_SYSTEM_POLL_INTERVAL_MS / 1000} sec
          </p>
          <h1 id="system-intel-title">Character and current system</h1>
        </div>
        <div
          className={`account-state ${account?.connected ? 'connected' : 'disconnected'}`}
          role="status"
        >
          <span aria-hidden="true" />
          {isStatusLoading
            ? 'Checking…'
            : account?.connected
              ? 'Character connected'
              : 'Character not connected'}
        </div>
      </div>

      {!supportsAccount ? (
        <div className="account-unavailable" role="status">
          <strong>SSO module did not load</strong>
          <p>Restart the updated app. Clipboard Intel below works independently.</p>
        </div>
      ) : isStatusLoading ? (
        <div className="system-intel-loading" role="status">
          <span />
          <span />
          <span />
          <p>Checking local SSO session…</p>
        </div>
      ) : !account?.connected ? (
        <div className="account-setup-grid">
          <form className="account-connect-form" onSubmit={(event) => void handleConnect(event)}>
            <div className="account-connect-copy">
              <strong>Connect a character</strong>
              <p>
                SSO provides the current system, ship, contacts, fleet roster, personal finances,
                and waypoints. On macOS sign-in lasts only until Fly Safe closes; on Windows,
                the refresh token stays in secure system storage.
              </p>
            </div>
            <div className="callback-field">
              <span>Fly Safe OAuth · already configured</span>
              <code>{callbackUri}</code>
            </div>
            <div className="account-connect-actions">
              <button
                type="submit"
                className="primary-button"
                disabled={accountAction !== null}
              >
                {accountAction === 'connect' ? 'Waiting for sign-in…' : 'Sign in with EVE Online'}
              </button>
            </div>
          </form>

          <aside className="account-setup-help">
            <strong>No manual setup</strong>
            <ol>
              <li><span>1</span>Select “Sign in with EVE Online”.</li>
              <li><span>2</span>Choose your character on the official page.</li>
              <li><span>3</span>Review permissions and approve access.</li>
            </ol>
            <div className="scope-list" aria-label="All requested ESI permissions">
              <span>10 ESI permissions · data is read-only; waypoints change only on request</span>
              <code>esi-location.read_location.v1</code>
              <code>esi-location.read_ship_type.v1</code>
              <code>esi-location.read_online.v1</code>
              <code>esi-characters.read_contacts.v1</code>
              <code>esi-fleets.read_fleet.v1</code>
              <code>esi-wallet.read_character_wallet.v1</code>
              <code>esi-markets.read_character_orders.v1</code>
              <code>esi-assets.read_assets.v1</code>
              <code>esi-universe.read_structures.v1</code>
              <code>esi-ui.write_waypoint.v1</code>
            </div>
          </aside>
        </div>
      ) : (
        <div className="connected-system">
          <div className="system-sticky-overview" aria-label="Pilot and current system">
          <div className="account-toolbar">
            <div className="connected-character">
              <span>Pilot</span>
              <strong>{account.characterName ?? `ID ${account.characterId ?? '—'}`}</strong>
              <b className={snapshot?.online === true ? 'online' : ''}>
                {snapshot?.online === true
                  ? 'ONLINE'
                  : snapshot?.online === false
                    ? 'OFFLINE'
                    : 'STATUS UNKNOWN'}
              </b>
            </div>
            <div className="account-toolbar-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  void refreshSystem(true)
                  void refreshPilotContext(true)
                }}
                disabled={isSystemRefreshing || accountAction !== null}
              >
                {isSystemRefreshing ? 'Refreshing…' : 'Refresh'}
              </button>
              <button
                type="button"
                className="text-button danger-text-button"
                onClick={() => void handleDisconnect()}
                disabled={accountAction !== null}
              >
                {accountAction === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          </div>

          {systemNotice && (
            <div className="system-stale-notice" role="status">
              <WarningIcon />
              <span>{systemNotice}</span>
            </div>
          )}

          {!intel && snapshot?.online === false ? (
            <div className="system-unavailable-state" role="status">
              <strong>CHARACTER OFFLINE</strong>
              <p>ESI does not report the current system while the character is out of game.</p>
            </div>
          ) : !intel && panelError ? (
            <div className="system-unavailable-state" role="status">
              <strong>Current system unavailable</strong>
              <p>The last request failed. Select Refresh to try again.</p>
            </div>
          ) : !intel && snapshot?.online === null ? (
            <div className="system-unavailable-state" role="status">
              <strong>Current system unavailable</strong>
              <p>ESI did not return online status or location. See warnings below for details.</p>
            </div>
          ) : !intel ? (
            <div className="system-intel-loading" role="status">
              <span />
              <span />
              <span />
              <p>Loading system and public combat history…</p>
            </div>
          ) : (
            <>
              <div className="system-overview">
                <div className="system-identity">
                  <span>Current system</span>
                  <strong>{intel.system.name}</strong>
                  <p>
                    <b>SEC {formatSecurityStatus(intel.system.securityStatus)}</b>
                    {intel.system.securityClass && ` · ${intel.system.securityClass}`}
                    {' · '}
                    {intel.system.regionName ?? 'Region unknown'}
                    {intel.system.constellationName && ` · ${intel.system.constellationName}`}
                  </p>
                </div>
                <div className={`system-danger danger-${intel.danger.level}`}>
                  <span>{SYSTEM_DANGER_LABELS[intel.danger.level]}</span>
                  <strong>{intel.danger.score}</strong>
                  <small>risk / 100</small>
                </div>
                <div className="own-ship-card">
                  {snapshot?.ownShip ? (
                    <>
                      <EveTypeImage
                        typeId={snapshot.ownShip.typeId}
                        variant="render"
                        requestSize={256}
                        className="own-ship-image"
                      />
                      <div>
                        <span>Your ship now</span>
                        <strong>
                          {snapshot.ownShip.typeName ?? `Type ${snapshot.ownShip.typeId}`}
                        </strong>
                        {snapshot.ownShip.customName && <small>{snapshot.ownShip.customName}</small>}
                      </div>
                    </>
                  ) : (
                    <div className="own-ship-empty">
                      <span>Your ship</span>
                      <strong>No data</strong>
                    </div>
                  )}
                </div>
              </div>

              {intel.danger.reasons.length > 0 && (
                <div className="danger-reasons" aria-label="Danger assessment reasons">
                  {intel.danger.reasons.map((reason) => <span key={reason}>{reason}</span>)}
                </div>
              )}

              <div className="system-metrics" aria-label="Historical system activity">
                <article><span>Ships destroyed</span><strong>{formatSystemMetric(intel.lastHour.shipKills)}</strong><small>ESI · last 1 h</small></article>
                <article><span>Pods destroyed</span><strong>{formatSystemMetric(intel.lastHour.podKills)}</strong><small>ESI · last 1 h</small></article>
                <article><span>NPC kills</span><strong>{formatSystemMetric(intel.lastHour.npcKills)}</strong><small>ESI · last 1 h</small></article>
                <article><span>Jumps</span><strong>{formatSystemMetric(intel.lastHour.jumps)}</strong><small>ESI · last 1 h</small></article>
                <article className="zkill-metric"><span>Killmails</span><strong>{intel.zkill24h.count === null ? '—' : formatSampleCount(intel.zkill24h.count, sourceCapped)}</strong><small>zKillboard · last 24 h{sourceCapped && ' · incomplete sample'}</small></article>
              </div>

            </>
          )}
          </div>

          {intel && (
            <>
              {sourceCapped && (
                <p className="source-cap-notice" role="note">
                  <strong>Incomplete zKillboard sample.</strong>{' '}
                  The source returned its one-page limit of 200 entries. Every “+” value is a lower bound.
                </p>
              )}

              <section className="historical-sightings" aria-labelledby="historical-ships-title">
                <div className="historical-heading">
                  <div>
                    <p className="eyebrow">Killmail history · 24 h</p>
                    <h2 id="historical-ships-title">Observed ships</h2>
                  </div>
                  <span title={observedShipsIncomplete ? 'Incomplete sample' : undefined}>
                    {formatSampleCount(observedShips.length, observedShipsIncomplete)}
                  </span>
                </div>
                {observedShips.length === 0 ? (
                  <p className="historical-empty">No ships found in public killmails for the past 24 hours.</p>
                ) : (
                  <div className="observed-ship-grid">
                    {visibleObservedShips.map((ship) => {
                      const expanded = expandedObservedShips.has(ship.typeId)
                      const detailsId = `observed-ship-details-${ship.typeId}`
                      const showAllOccurrences = showAllObservedShipOccurrences.has(ship.typeId)
                      const visibleOccurrences = showAllOccurrences
                        ? ship.occurrences
                        : ship.occurrences.slice(0, 8)
                      return (
                        <article
                          className={`observed-ship-card ${expanded ? 'expanded' : ''}`}
                          key={ship.typeId}
                        >
                          <button
                            type="button"
                            className="observed-ship-card-toggle"
                            aria-expanded={expanded}
                            aria-controls={detailsId}
                            onClick={() => setExpandedObservedShips((current) => {
                              const next = new Set(current)
                              if (!next.delete(ship.typeId)) next.add(ship.typeId)
                              return next
                            })}
                          >
                            <EveTypeImage
                              typeId={ship.typeId}
                              variant="render"
                              requestSize={128}
                              className="observed-ship-image"
                            />
                            <span className="observed-ship-copy">
                              <strong>{ship.name ?? `Type ${ship.typeId}`}</strong>
                              <span>
                                Attacked: {formatSampleCount(ship.attackerCount, sourceCapped)} · lost:{' '}
                                {formatSampleCount(ship.victimCount, sourceCapped)}
                              </span>
                              <small>
                                {formatSampleCount(ship.occurrences.length, ship.occurrencesCapped)} exact events · latest:{' '}
                                {formatCombatDate(ship.lastSeen)}
                              </small>
                            </span>
                            <b className="observed-card-chevron" aria-hidden="true">›</b>
                          </button>

                          {expanded && (
                            <div className="ship-pilot-drilldown" id={detailsId}>
                              <div className="ship-pilot-drilldown-heading">
                                <div>
                                  <strong>Killmails with this hull</strong>
                                  <small>Exact date, role, and pilot in every event</small>
                                </div>
                                <span>{formatSampleCount(ship.occurrences.length, ship.occurrencesCapped)}</span>
                              </div>
                              {ship.occurrences.length === 0 ? (
                                <p className="historical-empty">No exact capsuleer pilot involvement found.</p>
                              ) : (
                                <div className="ship-pilot-list">
                                  {visibleOccurrences.map((occurrence) => {
                                    const key = `ship:${ship.typeId}:${occurrence.killmailId}:${occurrence.role}:${occurrence.pilotCharacterId}`
                                    return (
                                      <div className="ship-pilot-entry" key={key}>
                                        <button
                                          type="button"
                                          className="ship-pilot-toggle"
                                          aria-label={`Open full pilot card for ${occurrence.pilotName ?? occurrence.pilotCharacterId}`}
                                          onClick={() => onOpenPilot({
                                            characterId: occurrence.pilotCharacterId,
                                            name: occurrence.pilotName,
                                            sourceLabel: `${ship.name ?? `Type ${ship.typeId}`} · Killmail #${occurrence.killmailId}`
                                          })}
                                        >
                                          <span>
                                            <strong>{occurrence.pilotName ?? `Pilot ${occurrence.pilotCharacterId}`}</strong>
                                            <small>{observedShipOccurrenceText(occurrence)}</small>
                                          </span>
                                          <span>
                                            {formatCombatDate(occurrence.time)} · Killmail #{occurrence.killmailId}
                                          </span>
                                          <b aria-hidden="true">›</b>
                                        </button>
                                        {occurrence.pilotName && (
                                          <PilotFavoriteButton
                                            pilot={{
                                              characterId: occurrence.pilotCharacterId,
                                              name: occurrence.pilotName
                                            }}
                                            favorite={watchlistById.has(occurrence.pilotCharacterId)}
                                            pending={watchlistPendingEntityKeys.has(
                                              toPilotWatchlistEntityKey(
                                                'character',
                                                occurrence.pilotCharacterId
                                              )
                                            )}
                                            onToggle={onToggleWatchlist}
                                          />
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                              {ship.occurrences.length > 8 && (
                                <button
                                  type="button"
                                  className="ship-event-history-toggle"
                                  aria-expanded={showAllOccurrences}
                                  onClick={() => setShowAllObservedShipOccurrences((current) =>
                                    toggleNumberSet(current, ship.typeId)
                                  )}
                                >
                                  {showAllOccurrences
                                    ? 'Show only latest 8'
                                    : `Show all events (${formatSampleCount(ship.occurrences.length, ship.occurrencesCapped)})`}
                                </button>
                              )}
                              <p className="historical-disclaimer">
                                Each row belongs to a specific killmail and time. This is history, not the pilot’s current ship.
                              </p>
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                )}
                {observedShips.length > 9 && (
                  <button
                    type="button"
                    className="historical-toggle"
                    aria-expanded={showAllObservedShips}
                    onClick={() => setShowAllObservedShips((current) => !current)}
                  >
                    {showAllObservedShips ? 'Collapse' : `Show all (${formatSampleCount(observedShips.length, observedShipsIncomplete)})`}
                  </button>
                )}
                <p className="historical-disclaimer">Historical killmail observations. These are not ships currently in the system.</p>
              </section>

              <section className="historical-sightings" aria-labelledby="historical-pilots-title">
                <div className="historical-heading">
                  <div>
                    <p className="eyebrow">Killmail history · 24 h</p>
                    <h2 id="historical-pilots-title">Observed pilots</h2>
                  </div>
                  <span title={observedPilotsIncomplete ? 'Incomplete sample' : undefined}>
                    {formatSampleCount(observedPilots.length, observedPilotsIncomplete)}
                  </span>
                </div>
                {observedPilots.length === 0 ? (
                  <p className="historical-empty">No pilots found in public killmails for the past 24 hours.</p>
                ) : (
                  <div className="observed-pilot-grid">
                    {visibleObservedPilots.map((pilot: SystemObservedPilot) => {
                      return (
                        <article
                          className={`observed-pilot-card ${watchlistById.has(pilot.characterId) ? 'watchlisted' : ''}`}
                          key={pilot.characterId}
                        >
                          <button
                            type="button"
                            className="observed-pilot-card-toggle"
                            aria-label={`Open full pilot card for ${pilot.name ?? pilot.characterId}`}
                            onClick={() => onOpenPilot({
                              characterId: pilot.characterId,
                              name: pilot.name,
                              sourceLabel: 'Current system killmail history'
                            })}
                          >
                            <span className="observed-pilot-copy">
                              <strong>{pilot.name ?? `Pilot ${pilot.characterId}`}</strong>
                              <span>Attacks: {formatSampleCount(pilot.attackerCount, sourceCapped)} · losses: {formatSampleCount(pilot.victimCount, sourceCapped)} · final: {formatSampleCount(pilot.finalBlowCount, sourceCapped)}</span>
                              <small>Latest killmail: {formatCombatDate(pilot.lastSeen)}</small>
                            </span>
                            <span
                              className="observed-pilot-ships"
                              aria-label={`Ship types: ${pilot.shipTypeIds.join(', ') || 'no data'}`}
                            >
                              {pilot.shipTypeIds.map((typeId) => (
                                <EveTypeImage
                                  key={typeId}
                                  typeId={typeId}
                                  variant="icon"
                                  requestSize={64}
                                  className="observed-pilot-ship-image"
                                />
                              ))}
                            </span>
                            <b className="observed-card-chevron" aria-hidden="true">›</b>
                          </button>
                          {pilot.name && (
                            <PilotFavoriteButton
                              pilot={{
                                characterId: pilot.characterId,
                                name: pilot.name
                              }}
                              favorite={watchlistById.has(pilot.characterId)}
                              pending={watchlistPendingEntityKeys.has(
                                toPilotWatchlistEntityKey('character', pilot.characterId)
                              )}
                              onToggle={onToggleWatchlist}
                            />
                          )}
                        </article>
                      )
                    })}
                  </div>
                )}
                {observedPilots.length > 10 && (
                  <button
                    type="button"
                    className="historical-toggle"
                    aria-expanded={showAllObservedPilots}
                    onClick={() => setShowAllObservedPilots((current) => !current)}
                  >
                    {showAllObservedPilots ? 'Collapse' : `Show all (${formatSampleCount(observedPilots.length, observedPilotsIncomplete)})`}
                  </button>
                )}
                <p className="historical-disclaimer">Historical killmail observations. This is not current Local or an enemy roster.</p>
              </section>

              <div className="system-refresh-stamp">
                Last location check: {formatCombatDate(snapshot?.fetchedAt ?? intel.fetchedAt)}
                {' · '}ESI: 1 h aggregates; zKillboard: 24 h window
                {' · '}system aggregates and killmail sample can be cached for up to 1 h; this is not a live feed
                {intel.cached && ' · response assembled from cache'}
              </div>
            </>
          )}

          <OperationalIntelPanels
            pilotContext={pilotContext}
            pilotStatus={pilotStatus}
            killAlerts={killAlerts}
            killAlertStatus={killAlertStatus}
            resolveSystemName={(solarSystemId) =>
              intel?.system.id === solarSystemId ? intel.system.name : null
            }
            maxVisibleAlerts={20}
          />
        </div>
      )}

      {(panelError || accountError) && (
        <div className="account-inline-error" role="alert">
          <WarningIcon />
          <span>{panelError ?? accountError}</span>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="system-warning-list" role="status">
          {warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      )}

      <div className="system-live-boundary">
        <WarningIcon />
        <p>
          <strong>SSO does not show current Local, enemies, or their ships.</strong>{' '}
          Current roster: use {SELECT_ALL_COPY_SHORTCUT} in EVE; Clipboard Intel below immediately shows analysis.
        </p>
      </div>
    </section>
  )
}

export interface AppProps {
  entitlementFeatures?: readonly string[] | null
}

interface LocalScanOutcome {
  result: ScanResult
  capturedAt: string
  systemSnapshot: CurrentSystemSnapshot | null
}

export default function App({
  entitlementFeatures = PRO_FEATURE_IDS
}: AppProps): React.JSX.Element {
  const api = useMemo(getApi, [])
  const proEnabled = PRO_FEATURE_IDS.some((feature) => (
    hasProFeature(entitlementFeatures, feature)
  ))
  const [workspaceState, setWorkspaceState] = useState(createPilotWorkspaceState)
  const activeWorkspace = workspaceState.activeWorkspace
  const activeWorkspaceRef = useRef<WorkspaceId>(activeWorkspace)
  activeWorkspaceRef.current = activeWorkspace
  const selectedPilot = workspaceState.target
  const [rawText, setRawText] = useState('')
  const [preview, setPreview] = useState<LocalPreview>({ names: [], rejected: 0 })
  const [activeClipboardMode, setActiveClipboardMode] = useState<ActiveClipboardMode>(null)
  const [tacticalClipboard, setTacticalClipboard] = useState<TacticalClipboardSnapshot | null>(null)
  const [currentSystemSnapshot, setCurrentSystemSnapshot] = useState<CurrentSystemSnapshot | null>(null)
  const [routePathSystemIds, setRoutePathSystemIds] = useState<number[]>([])
  const [result, setResult] = useState<ScanResult | null>(null)
  const [pilotRosterSource, setPilotRosterSource] = useState<PilotRosterSource | null>(null)
  const [pendingLocalObservation, setPendingLocalObservation] = useState<
    PilotRosterObservationCandidate | null
  >(null)
  const [isConfirmingLocal, setIsConfirmingLocal] = useState(false)
  const [watchlist, setWatchlist] = useState<PilotWatchlistSnapshot>(EMPTY_WATCHLIST)
  const [watchlistLoading, setWatchlistLoading] = useState(true)
  const [pilotContextForImport, setPilotContextForImport] = useState<PilotContext | null>(null)
  const [importingEveContacts, setImportingEveContacts] = useState(false)
  const [watchlistPendingEntityKeys, setWatchlistPendingEntityKeys] = useState<
    Set<PilotWatchlistEntityKey>
  >(
    () => new Set()
  )
  const [watchlistSoundEnabled, setWatchlistSoundEnabled] = useState(
    savedWatchlistSoundPreference
  )
  const [uiSettings, setUiSettings] = useState<UiSettings>({ ...DEFAULT_UI_SETTINGS })
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [progress, setProgress] = useState<ScanProgress>({
    completed: 0,
    total: 0,
    currentName: null
  })
  const [readyPilots, setReadyPilots] = useState<PilotIntel[]>([])
  const [isScanning, setIsScanning] = useState(false)
  const [isReadingClipboard, setIsReadingClipboard] = useState(false)
  const [isClearingCache, setIsClearingCache] = useState(false)
  const [autoClipboard, setAutoClipboard] = useState(savedAutoClipboardPreference)
  const autoClipboardRef = useRef(autoClipboard)
  autoClipboardRef.current = autoClipboard
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [threatFilter, setThreatFilter] = useState<ThreatFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('risk')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [riskPriority, setRiskPriority] = useState<RiskPriority>(savedRiskPriorityPreference)
  const [priorityEvidenceByPilot, setPriorityEvidenceByPilot] = useState<
    Map<number, PriorityEvidenceState>
  >(() => new Map())
  const priorityEvidenceGenerationRef = useRef(0)
  const scanningRef = useRef(false)
  const suppressScanProgressRef = useRef(false)
  const confirmingLocalRef = useRef(false)
  const lastConfirmedLocalCandidateRef = useRef<string | null>(null)
  const lastClipboardRef = useRef('')
  const dscanSequenceRef = useRef(0)
  const latestDscanCaptureRef = useRef<string | null>(null)
  const previousDscanRowsRef = useRef<DscanRow[] | null>(null)
  const previousProbeRowsRef = useRef<ProbeRow[] | null>(null)
  const previousProbeSystemIdRef = useRef<number | null>(null)
  const watchlistRef = useRef<readonly PilotWatchlistEntry[]>([])
  const presentWatchlistEntityKeysRef = useRef<PilotWatchlistEntityKey[]>([])
  const systemWatchlistPresenceRef = useRef<{
    systemId: number | null
    entityKeys: PilotWatchlistEntityKey[]
  }>({ systemId: null, entityKeys: [] })
  const watchlistSoundEnabledRef = useRef(watchlistSoundEnabled)
  const uiSettingsRef = useRef<UiSettings>(uiSettings)
  const watchlistSoundAlertAtRef = useRef<Map<string, number>>(new Map())
  const watchlistNoticeAlertAtRef = useRef<Map<string, number>>(new Map())
  const watchlistNativeAlertAtRef = useRef<Map<string, number>>(new Map())
  const currentClipboardSystemIdRef = useRef<number | null>(null)
  const currentSystemSnapshotRef = useRef<CurrentSystemSnapshot | null>(null)
  const lastRecordedPositionKeyRef = useRef<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const clipboardInputRef = useRef<HTMLElement | null>(null)
  const clipboardResultRef = useRef<HTMLDivElement | null>(null)
  const workspaceScrollRef = useRef<Record<WorkspaceId, number>>({
    intel: 0,
    market: 0,
    industry: 0,
    production: 0,
    route: 0,
    watchlist: 0,
    journal: 0,
    finance: 0,
    pro: 0,
    settings: 0,
    pilot: 0
  })
  const workspaceNavigationSequenceRef = useRef(0)
  const clipboardOperationSequenceRef = useRef(0)
  const clipboardScrollSequenceRef = useRef(0)
  const [clipboardScrollRequest, setClipboardScrollRequest] = useState<{
    sequence: number
    target: 'input' | 'result'
  } | null>(null)

  const updateAutoClipboard = useCallback((enabled: boolean): void => {
    autoClipboardRef.current = enabled
    clipboardOperationSequenceRef.current += 1
    setAutoClipboard(enabled)
  }, [])

  const updateRiskPriority = useCallback((priority: RiskPriority): void => {
    setRiskPriority(priority)
    try {
      window.localStorage.setItem(RISK_PRIORITY_KEY, priority)
    } catch {
      // The operational choice still works when localStorage is unavailable.
    }
  }, [])

  watchlistSoundEnabledRef.current = watchlistSoundEnabled
  uiSettingsRef.current = uiSettings

  const applyUiSettings = useCallback((nextSettings: UiSettings): void => {
    uiSettingsRef.current = nextSettings
    setUiSettings(nextSettings)
    api?.setUiScale(nextSettings.scalePercent)
    applyUiSettingsToDocument(nextSettings)
  }, [api])

  const pollingIntervals = useMemo(() => uiPollingIntervalsMs(uiSettings), [uiSettings])

  const enqueueClipboardScroll = useCallback((target: 'input' | 'result'): void => {
    clipboardScrollSequenceRef.current += 1
    setClipboardScrollRequest({
      sequence: clipboardScrollSequenceRef.current,
      target
    })
  }, [])

  const requestClipboardScroll = useCallback((target: 'input' | 'result'): void => {
    if (activeWorkspaceRef.current !== 'intel') return
    enqueueClipboardScroll(target)
  }, [enqueueClipboardScroll])

  const rememberWorkspaceScroll = useCallback((): void => {
    workspaceScrollRef.current[activeWorkspaceRef.current] = window.scrollY
  }, [])

  const switchWorkspace = useCallback((workspace: WorkspaceId): void => {
    rememberWorkspaceScroll()
    workspaceNavigationSequenceRef.current += 1
    activeWorkspaceRef.current = workspace
    setWorkspaceState((current) => selectWorkspace(current, workspace))
  }, [rememberWorkspaceScroll])

  const navigateToClipboard = useCallback((target: 'input' | 'result'): void => {
    if (activeWorkspaceRef.current !== 'intel') switchWorkspace('intel')
    enqueueClipboardScroll(target)
  }, [enqueueClipboardScroll, switchWorkspace])

  useEffect(() => {
    if (proEnabled) return
    setWorkspaceState((current) => current.activeWorkspace === 'pro'
      ? selectWorkspace(current, 'intel')
      : current)
  }, [proEnabled])

  useEffect(() => {
    const openMarket = (): void => switchWorkspace('market')
    window.addEventListener(MARKET_DRAFT_EVENT, openMarket)
    return () => window.removeEventListener(MARKET_DRAFT_EVENT, openMarket)
  }, [switchWorkspace])

  useEffect(() => {
    if (!api || typeof api.onWorkspaceNavigation !== 'function') return
    return api.onWorkspaceNavigation((workspace) => switchWorkspace(workspace))
  }, [api, switchWorkspace])

  const handleOpenPilot = useCallback((selection: PilotWorkspaceSelection): void => {
    rememberWorkspaceScroll()
    workspaceScrollRef.current.pilot = 0
    workspaceNavigationSequenceRef.current += 1
    activeWorkspaceRef.current = 'pilot'
    setClipboardScrollRequest(null)
    setWorkspaceState((current) => openPilotWorkspace(current, selection))
  }, [rememberWorkspaceScroll])

  const handleReturnFromPilot = useCallback((): void => {
    rememberWorkspaceScroll()
    workspaceNavigationSequenceRef.current += 1
    setWorkspaceState((current) => {
      const next = returnFromPilotWorkspace(current)
      activeWorkspaceRef.current = next.activeWorkspace
      return next
    })
  }, [rememberWorkspaceScroll])

  const handleClosePilot = useCallback((): void => {
    rememberWorkspaceScroll()
    workspaceNavigationSequenceRef.current += 1
    setWorkspaceState((current) => {
      const next = closePilotWorkspace(current)
      activeWorkspaceRef.current = next.activeWorkspace
      return next
    })
  }, [rememberWorkspaceScroll])

  const handleCurrentSystemSnapshot = useCallback(
    (nextSnapshot: CurrentSystemSnapshot | null): void => {
      const nextSystemId = nextSnapshot?.online === true
        ? nextSnapshot.location?.solarSystemId ?? null
        : null
      if (currentClipboardSystemIdRef.current !== nextSystemId) {
        previousDscanRowsRef.current = null
        previousProbeRowsRef.current = null
        previousProbeSystemIdRef.current = null
      }
      currentClipboardSystemIdRef.current = nextSystemId
      currentSystemSnapshotRef.current = nextSnapshot
      setCurrentSystemSnapshot(nextSnapshot)
    },
    []
  )

  const handleRouteResult = useCallback((routeResult: RouteIntelResult): void => {
    setRoutePathSystemIds(routeResult.systems.map((system) => system.systemId))
  }, [])

  const routeCorridorSystemIds = useMemo(() => {
    const currentId = currentSystemSnapshot?.location?.solarSystemId ?? null
    const currentIndex = currentId === null ? -1 : routePathSystemIds.indexOf(currentId)
    const forward = currentIndex >= 0
      ? routePathSystemIds.slice(currentIndex + 1)
      : routePathSystemIds
    return [...new Set(forward)].slice(0, 255)
  }, [currentSystemSnapshot?.location?.solarSystemId, routePathSystemIds])

  const showNotice = useCallback((message: string): void => {
    setNotice(message)
    if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3200)
  }, [])

  const recordEncounterSnapshot = useCallback((observation: {
    capturedAt?: string
    localPilots?: Array<{
      characterId?: number | null
      name: string
      corporationName?: string | null
    }>
    dscanHulls?: Array<{
      typeId?: number | null
      typeName?: string | null
      count?: number
    }>
  } = {}): void => {
    const snapshot = currentSystemSnapshotRef.current
    const solarSystemId = snapshot?.location?.solarSystemId
    if (!api || !solarSystemId) return

    void api.recordEncounter({
      capturedAt: observation.capturedAt,
      currentSystem: {
        solarSystemId,
        name: snapshot.intel?.system.id === solarSystemId
          ? snapshot.intel.system.name
          : null
      },
      ownShip: snapshot.ownShip
        ? {
            typeId: snapshot.ownShip.typeId,
            typeName: snapshot.ownShip.typeName,
            customName: snapshot.ownShip.customName
          }
        : null,
      localPilots: observation.localPilots,
      dscanHulls: observation.dscanHulls
    }).catch(() => undefined)
  }, [api])

  useEffect(() => {
    const solarSystemId = currentSystemSnapshot?.location?.solarSystemId ?? null
    if (solarSystemId === null) return
    const positionKey = [
      solarSystemId,
      currentSystemSnapshot?.ownShip?.typeId ?? 'no-ship',
      currentSystemSnapshot?.ownShip?.customName ?? ''
    ].join(':')
    if (lastRecordedPositionKeyRef.current === positionKey) return
    lastRecordedPositionKeyRef.current = positionKey
    recordEncounterSnapshot()
  }, [currentSystemSnapshot, recordEncounterSnapshot])

  const announceWatchlistEntries = useCallback((
    entries: readonly PilotWatchlistEntry[],
    source:
      | { kind: 'local' }
      | { kind: 'dscan' }
      | { kind: 'system-history'; systemName: string }
      | { kind: 'r2z2'; systemName: string }
  ): void => {
    const sourceRule = source.kind === 'system-history' ? 'system-killmail' : source.kind
    const uniqueEntries = [...new Map(entries.map((entry) => [
      getPilotWatchlistEntityKey(entry),
      entry
    ])).values()].filter((entry) => getPilotWatchlistAlertSources(entry).includes(sourceRule))
    if (uniqueEntries.length === 0) return

    const now = Date.now()
    const channelKey = (entry: PilotWatchlistEntry): string => (
      `${getPilotWatchlistEntityKey(entry)}:${sourceRule}`
    )
    const messageFor = (channelEntries: readonly PilotWatchlistEntry[]): string => {
      const visibleNames = channelEntries.slice(0, 8).map((entry) => entry.name)
      const remaining = channelEntries.length - visibleNames.length
      const names = `${visibleNames.join(', ')}${remaining > 0 ? ` and ${remaining} more` : ''}`
      return source.kind === 'local'
        ? `⚠ Dangerous contact in Local: ${names}`
        : source.kind === 'dscan'
          ? `⚠ Dangerous contact matched on D-scan: ${names}`
          : source.kind === 'r2z2'
            ? `⚠ Contact appears in new killmail in ${source.systemName}: ${names}`
            : `⚠ Contact observed in history for ${source.systemName}: ${names}`
    }

    const soundEntries = watchlistSoundEnabledRef.current &&
      uiSettingsRef.current.soundVolumePercent > 0
      ? uniqueEntries.filter((entry) => (
          entry.volume !== 0 && shouldPlayPilotWatchlistAlert(
            entry,
            sourceRule,
            watchlistSoundAlertAtRef.current.get(channelKey(entry)) ?? null,
            now
          )
        ))
      : []
    if (soundEntries.length > 0) {
      const severityOrder = { watch: 0, danger: 1, critical: 2 } as const
      const loudest = [...soundEntries]
        .sort((left, right) => (
          severityOrder[getPilotWatchlistSeverity(right)] -
          severityOrder[getPilotWatchlistSeverity(left)]
        ))[0]
      void tryPlayPilotWatchlistAlert({
        soundId: loudest.soundId,
        volume: loudest.volume,
        globalVolumePercent: uiSettingsRef.current.soundVolumePercent
      }).then((played) => {
        if (!played) return
        for (const entry of soundEntries) {
          watchlistSoundAlertAtRef.current.set(channelKey(entry), now)
        }
      }).catch((caught) => {
        for (const entry of soundEntries) {
          const key = channelKey(entry)
          if (watchlistSoundAlertAtRef.current.get(key) === now) {
            watchlistSoundAlertAtRef.current.delete(key)
          }
        }
        setError(`Sound alert did not play: ${errorMessage(caught)}`)
      })
    }

    const noticeEntries = uniqueEntries.filter((entry) => shouldEmitPilotWatchlistAlert(
      entry,
      sourceRule,
      watchlistNoticeAlertAtRef.current.get(channelKey(entry)) ?? null,
      now
    ))
    if (noticeEntries.length > 0) {
      showNotice(messageFor(noticeEntries))
      for (const entry of noticeEntries) {
        watchlistNoticeAlertAtRef.current.set(channelKey(entry), now)
      }
    }

    if (
      uiSettingsRef.current.backgroundNotificationsEnabled &&
      api &&
      typeof api.showNativeAlert === 'function'
    ) {
      const nativeEntries = uniqueEntries.filter((entry) => shouldEmitPilotWatchlistAlert(
        entry,
        sourceRule,
        watchlistNativeAlertAtRef.current.get(channelKey(entry)) ?? null,
        now
      ))
      if (nativeEntries.length === 0) return
      const message = messageFor(nativeEntries)
      const nativeBody = message.replace(/^⚠\s*/, '')
      const boundedNativeBody = nativeBody.length <= 470
        ? nativeBody
        : `${nativeBody.slice(0, 469)}…`
      const cooldownSeconds = Math.max(
        1,
        ...nativeEntries.map((entry) => entry.cooldownSeconds ?? 60)
      )
      void api.showNativeAlert({
        title: 'Fly Safe · dangerous contact',
        body: boundedNativeBody,
        kind: 'watchlist',
        workspace: 'watchlist',
        dedupeKey: `watchlist:${sourceRule}:${nativeEntries
          .slice(0, 5)
          .map(getPilotWatchlistEntityKey)
          .join(',')}:${nativeEntries.length}`,
        cooldownMs: Math.min(24 * 60 * 60_000, cooldownSeconds * 1_000),
        silent: true
      }).then((result) => {
        if (!result.shown) return
        for (const entry of nativeEntries) {
          watchlistNativeAlertAtRef.current.set(channelKey(entry), now)
        }
      }).catch(() => undefined)
    }
  }, [api, showNotice])

  const handleKillAlertsObserved = useCallback((alerts: readonly KillAlert[]): void => {
    for (const alert of filterOperationalPilotWatchlistAlerts(alerts)) {
      const participants = [alert.victim, ...alert.attackers]
      const matchingEntries = watchlistRef.current.filter((entry) => {
        const entityType = getPilotWatchlistEntityType(entry)
        const entityId = getPilotWatchlistEntityId(entry)
        return participants.some((participant) => (
          entityType === 'character'
            ? participant.characterId === entityId
            : entityType === 'corporation'
              ? participant.corporationId === entityId
              : participant.allianceId === entityId
        ))
      })
      const systemName = currentSystemSnapshotRef.current?.intel?.system.id === alert.solarSystemId
        ? currentSystemSnapshotRef.current.intel.system.name
        : `system ${alert.solarSystemId}`
      announceWatchlistEntries(matchingEntries, { kind: 'r2z2', systemName })

      if (
        !uiSettingsRef.current.backgroundNotificationsEnabled ||
        !api ||
        typeof api.showNativeAlert !== 'function'
      ) continue
      const victimShip = alert.victim.shipTypeName ?? `type ${alert.victim.shipTypeId}`
      void api.showNativeAlert({
        title: `Fly Safe · new killmail · ${systemName}`,
        body: `${victimShip} destroyed. Participants: ${alert.attackers.filter((item) => item.capsuleer).length}.`,
        kind: 'r2z2',
        // The live R2Z2 feed is rendered in Intelligence; the Route tab shows
        // the separate historical Camp Radar snapshot.
        workspace: 'intel',
        dedupeKey: `r2z2:${alert.killmailId}`,
        cooldownMs: 24 * 60 * 60_000,
        silent: true
      }).catch(() => undefined)
    }
  }, [announceWatchlistEntries, api])

  const handleDscanCandidatesObserved = useCallback((
    candidates: readonly DscanPilotCandidate[]
  ): void => {
    const candidateIds = new Set(candidates.map((candidate) => candidate.characterId))
    const entries = watchlistRef.current.filter((entry) => (
      getPilotWatchlistEntityType(entry) === 'character' &&
      candidateIds.has(getPilotWatchlistEntityId(entry))
    ))
    announceWatchlistEntries(entries, { kind: 'dscan' })
  }, [announceWatchlistEntries])

  const watchlistById = useMemo(
    () => new Map(watchlist.entries
      .filter((entry) => getPilotWatchlistEntityType(entry) === 'character')
      .map((entry) => [getPilotWatchlistEntityId(entry), entry])),
    [watchlist.entries]
  )

  const eveContactImportCount = useMemo(() => {
    const existingKeys = new Set(watchlist.entries.map(getPilotWatchlistEntityKey))
    return pilotContextForImport?.contacts?.entries.filter((contact) => (
      contact.type !== 'faction' &&
      contact.name !== null &&
      (contact.standing < 0 || contact.watched || contact.blocked) &&
      !existingKeys.has(toPilotWatchlistEntityKey(contact.type, contact.id))
    )).length ?? 0
  }, [pilotContextForImport, watchlist.entries])

  const applyWatchlistSnapshot = useCallback((snapshot: PilotWatchlistSnapshot): void => {
    watchlistRef.current = snapshot.entries
    const remainingKeys = new Set(snapshot.entries.map(getPilotWatchlistEntityKey))
    presentWatchlistEntityKeysRef.current = presentWatchlistEntityKeysRef.current
      .filter((entityKey) => remainingKeys.has(entityKey))
    setWatchlist(snapshot)
  }, [])

  const markWatchlistPending = useCallback((entityKey: PilotWatchlistEntityKey, pending: boolean): void => {
    setWatchlistPendingEntityKeys((current) => {
      const next = new Set(current)
      if (pending) next.add(entityKey)
      else next.delete(entityKey)
      return next
    })
  }, [])

  const togglePilotWatchlist = useCallback(async (
    pilot: PilotFavoriteCandidate
  ): Promise<void> => {
    const entityKey = toPilotWatchlistEntityKey('character', pilot.characterId)
    if (!api || watchlistPendingEntityKeys.has(entityKey)) return
    markWatchlistPending(entityKey, true)
    setError(null)
    try {
      const existingEntry = watchlistRef.current.find(
        (entry) => getPilotWatchlistEntityType(entry) === 'character' &&
          getPilotWatchlistEntityId(entry) === pilot.characterId
      )
      if (
        existingEntry?.note &&
        !window.confirm(`Remove ${existingEntry.name} and its saved note from the watchlist?`)
      ) {
        return
      }
      const snapshot = existingEntry
        ? await api.removePilotWatchlist({
            characterId: pilot.characterId,
            entityType: 'character',
            entityId: pilot.characterId
          })
        : await api.upsertPilotWatchlist({
            characterId: pilot.characterId,
            name: pilot.name,
            corporationName: pilot.corporationName ?? null,
            alertSoundEnabled: true
          })
      applyWatchlistSnapshot(snapshot)
      showNotice(existingEntry
        ? `${pilot.name}: removed from watchlist`
        : `${pilot.name}: added as dangerous contact`)
    } catch (caught) {
      setError(`Could not update watchlist: ${errorMessage(caught)}`)
    } finally {
      markWatchlistPending(entityKey, false)
    }
  }, [
    api,
    applyWatchlistSnapshot,
    markWatchlistPending,
    showNotice,
    watchlistPendingEntityKeys
  ])

  const updatePilotWatchlist = useCallback(async (
    entry: PilotWatchlistEntry,
    patch: { note?: string | null; alertSoundEnabled?: boolean }
  ): Promise<void> => {
    const entityKey = getPilotWatchlistEntityKey(entry)
    if (!api || watchlistPendingEntityKeys.has(entityKey)) return
    markWatchlistPending(entityKey, true)
    setError(null)
    try {
      const snapshot = await api.upsertPilotWatchlist({
        characterId: getPilotWatchlistEntityId(entry),
        entityType: getPilotWatchlistEntityType(entry),
        entityId: getPilotWatchlistEntityId(entry),
        name: entry.name,
        ...patch
      })
      applyWatchlistSnapshot(snapshot)
      showNotice(`${entry.name}: settings saved`)
    } catch (caught) {
      setError(`Could not save contact: ${errorMessage(caught)}`)
    } finally {
      markWatchlistPending(entityKey, false)
    }
  }, [
    api,
    applyWatchlistSnapshot,
    markWatchlistPending,
    showNotice,
    watchlistPendingEntityKeys
  ])

  const updateAdvancedWatchlist = useCallback(async (
    entry: PilotWatchlistEntry,
    patch: PilotWatchlistAdvancedPatch
  ): Promise<void> => {
    if (!api) return
    const entityId = getPilotWatchlistEntityId(entry)
    const entityKey = getPilotWatchlistEntityKey(entry)
    if (watchlistPendingEntityKeys.has(entityKey)) return
    markWatchlistPending(entityKey, true)
    setError(null)
    try {
      const snapshot = await api.upsertPilotWatchlist({
        characterId: entityId,
        entityType: getPilotWatchlistEntityType(entry),
        entityId,
        name: entry.name,
        ...patch
      })
      applyWatchlistSnapshot(snapshot)
      showNotice(`${entry.name}: alert rules saved`)
    } catch (caught) {
      setError(`Could not save rules: ${errorMessage(caught)}`)
    } finally {
      markWatchlistPending(entityKey, false)
    }
  }, [
    api,
    applyWatchlistSnapshot,
    markWatchlistPending,
    showNotice,
    watchlistPendingEntityKeys
  ])

  const createWatchlistEntity = useCallback(async (
    request: PilotWatchlistUpsertRequest
  ): Promise<void> => {
    if (!api) return
    const entityId = request.entityId ?? request.characterId
    const entityType = request.entityType ?? 'character'
    if (!entityId) return
    const entityKey = toPilotWatchlistEntityKey(entityType, entityId)
    if (watchlistPendingEntityKeys.has(entityKey)) return
    markWatchlistPending(entityKey, true)
    setError(null)
    try {
      const snapshot = await api.upsertPilotWatchlist(request)
      applyWatchlistSnapshot(snapshot)
      showNotice(`${request.name}: added to watchlist`)
    } catch (caught) {
      setError(`Could not add contact: ${errorMessage(caught)}`)
    } finally {
      markWatchlistPending(entityKey, false)
    }
  }, [
    api,
    applyWatchlistSnapshot,
    markWatchlistPending,
    showNotice,
    watchlistPendingEntityKeys
  ])

  const importEveContacts = useCallback(async (): Promise<void> => {
    if (!api || importingEveContacts) return
    setImportingEveContacts(true)
    setError(null)
    try {
      const snapshot = await api.importEveWatchlistContacts()
      applyWatchlistSnapshot(snapshot)
      showNotice('Dangerous and watched EVE contacts imported')
    } catch (caught) {
      setError(`Could not import EVE contacts: ${errorMessage(caught)}`)
    } finally {
      setImportingEveContacts(false)
    }
  }, [api, applyWatchlistSnapshot, importingEveContacts, showNotice])

  const removePilotWatchlistEntry = useCallback(async (
    entry: PilotWatchlistEntry
  ): Promise<void> => {
    const entityId = getPilotWatchlistEntityId(entry)
    const entityKey = getPilotWatchlistEntityKey(entry)
    if (!api || watchlistPendingEntityKeys.has(entityKey)) return
    if (
      entry.note &&
      !window.confirm(`Remove ${entry.name} and its saved note from the watchlist?`)
    ) {
      return
    }
    markWatchlistPending(entityKey, true)
    setError(null)
    try {
      const snapshot = await api.removePilotWatchlist({
        characterId: entityId,
        entityType: getPilotWatchlistEntityType(entry),
        entityId
      })
      applyWatchlistSnapshot(snapshot)
      showNotice(`${entry.name}: removed from watchlist`)
    } catch (caught) {
      setError(`Could not remove contact: ${errorMessage(caught)}`)
    } finally {
      markWatchlistPending(entityKey, false)
    }
  }, [
    api,
    applyWatchlistSnapshot,
    markWatchlistPending,
    showNotice,
    watchlistPendingEntityKeys
  ])

  const testWatchlistSound = useCallback((): void => {
    void playPilotWatchlistAlert(uiSettingsRef.current.soundVolumePercent)
      .then(() => showNotice('Sound alert test'))
      .catch((caught) => setError(`Could not play sound: ${errorMessage(caught)}`))
  }, [showNotice])

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: workspaceScrollRef.current[activeWorkspace], behavior: 'auto' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeWorkspace])

  useEffect(() => {
    if (activeWorkspace !== 'intel') setClipboardScrollRequest(null)
  }, [activeWorkspace])

  useEffect(() => {
    if (!clipboardScrollRequest || activeWorkspace !== 'intel') return

    const frame = window.requestAnimationFrame(() => {
      const target = clipboardScrollRequest.target === 'result'
        ? clipboardResultRef.current
        : clipboardInputRef.current
      if (!target) return

      const prefersReducedMotion = typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      target.scrollIntoView({
        behavior: getClipboardScrollBehavior(prefersReducedMotion),
        block: 'start'
      })
      setClipboardScrollRequest((current) => (
        current?.sequence === clipboardScrollRequest.sequence ? null : current
      ))
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeWorkspace, clipboardScrollRequest])

  useEffect(() => {
    try {
      window.localStorage.setItem(AUTO_CLIPBOARD_KEY, String(autoClipboard))
    } catch {
      // Preference persistence is optional; scanning still works for this run.
    }
  }, [autoClipboard])

  useEffect(() => {
    try {
      window.localStorage.setItem(WATCHLIST_SOUND_KEY, String(watchlistSoundEnabled))
    } catch {
      // The sound setting remains valid for this session when storage is unavailable.
    }
  }, [watchlistSoundEnabled])

  useEffect(() => {
    const intel = currentSystemSnapshot?.online === true
      ? currentSystemSnapshot.intel
      : null
    if (!intel) {
      systemWatchlistPresenceRef.current = { systemId: null, entityKeys: [] }
      return
    }

    const systemId = intel.system.id
    const previousEntityKeys = systemWatchlistPresenceRef.current.systemId === systemId
      ? systemWatchlistPresenceRef.current.entityKeys
      : []
    const presence = reconcilePilotWatchlistPresence(
      previousEntityKeys,
      watchlist.entries,
      {
        pilots: intel.zkill24h.observedPilots.map((pilot) => ({
          id: pilot.characterId,
          name: pilot.name ?? ''
        })),
        unresolvedNames: []
      }
    )
    systemWatchlistPresenceRef.current = {
      systemId,
      entityKeys: presence.presentEntityKeys
    }
    announceWatchlistEntries(
      presence.entered.map(({ entry }) => entry),
      { kind: 'system-history', systemName: intel.system.name }
    )
  }, [announceWatchlistEntries, currentSystemSnapshot, watchlist.entries])

  useEffect(() => {
    if (!api) {
      setError(
        'Desktop app bridge unavailable. Restart Fly Safe.'
      )
      return
    }

    let active = true
    void api
      .getStatus()
      .then((nextStatus) => {
        if (active) setStatus(nextStatus)
      })
      .catch((caught) => {
        if (active) setError(`Could not open local database: ${errorMessage(caught)}`)
      })

    void api
      .getPilotWatchlist()
      .then((snapshot) => {
        if (!active) return
        watchlistRef.current = snapshot.entries
        setWatchlist(snapshot)
      })
      .catch((caught) => {
        if (active) setError(`Could not load watchlist: ${errorMessage(caught)}`)
      })
      .finally(() => {
        if (active) setWatchlistLoading(false)
      })

    const unsubscribe = api.onScanProgress((nextProgress) => {
      if (!active || suppressScanProgressRef.current) return
      setProgress(nextProgress)
      const readyPilot = nextProgress.readyPilot
      if (scanningRef.current && readyPilot) {
        setReadyPilots((current) => upsertReadyPilot(current, readyPilot))
      }
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [api])

  useEffect(() => {
    if (rawText.trim().length === 0) {
      setPreview({ names: [], rejected: 0 })
      return
    }

    const timer = window.setTimeout(() => {
      const detection = classifyEveClipboard(rawText)
      setPreview(
        detection.kind === 'dscan' || detection.kind === 'probe'
          ? { names: [], rejected: 0 }
          : parseLocalRoster(rawText)
      )
    }, 120)

    return () => window.clearTimeout(timer)
  }, [rawText])

  const commitLocalScan = useCallback((
    outcome: LocalScanOutcome,
    source: 'manual' | 'auto'
  ): void => {
    setResult(outcome.result)
    setReadyPilots([])
    setPilotRosterSource('lookup')
    setPendingLocalObservation({
      capturedAt: outcome.capturedAt,
      systemSnapshot: outcome.systemSnapshot,
      result: outcome.result
    })
    setError(null)
    requestClipboardScroll('result')
    if (source === 'auto') {
      showNotice(`Automatic check: ${outcome.result.summary.resolved} pilots · Hunter unchanged`)
    }
    void api?.getStatus()
      .then((nextStatus) => setStatus(nextStatus))
      .catch(() => undefined)
  }, [api, requestClipboardScroll, showNotice])

  const runScan = useCallback(
    async (
      text: string,
      source: 'manual' | 'auto' = 'manual',
      options: { stageOnly?: boolean } = {}
    ): Promise<LocalScanOutcome | null> => {
      const stageOnly = options.stageOnly === true
      if (!api || scanningRef.current || confirmingLocalRef.current) return null
      const cleanText = text.trim()
      if (!cleanText) {
        if (!stageOnly) {
          setError('Paste a character name or pilot list — one per line.')
        }
        return null
      }

      const capturedAt = new Date().toISOString()
      const systemSnapshot = currentSystemSnapshotRef.current
      scanningRef.current = true
      suppressScanProgressRef.current = stageOnly
      if (!stageOnly) {
        setIsScanning(true)
        setResult(null)
        setReadyPilots([])
        setPilotRosterSource(null)
        setPendingLocalObservation(null)
        setError(null)
        setProgress({ completed: 0, total: 0, currentName: null })
      }

      try {
        const nextResult = await api.analyzeLocal({ rawText: cleanText })
        const outcome: LocalScanOutcome = {
          result: nextResult,
          capturedAt,
          systemSnapshot
        }
        if (!stageOnly) commitLocalScan(outcome, source)
        return outcome
      } catch (caught) {
        if (!stageOnly) {
          setReadyPilots([])
          setError(
            `Scan did not finish. Check your network and retry: ${errorMessage(caught)}`
          )
        }
        return null
      } finally {
        scanningRef.current = false
        suppressScanProgressRef.current = false
        if (!stageOnly) setIsScanning(false)
      }
    },
    [api, commitLocalScan]
  )

  const confirmLocalObservation = useCallback(async (): Promise<void> => {
    const candidateKey = pendingLocalObservation
      ? `${pendingLocalObservation.capturedAt}:${pendingLocalObservation.result.scannedAt}`
      : null
    if (
      !api ||
      !pendingLocalObservation ||
      candidateKey === null ||
      lastConfirmedLocalCandidateRef.current === candidateKey ||
      pilotRosterSource === 'confirmed-local' ||
      confirmingLocalRef.current
    ) return

    confirmingLocalRef.current = true
    setIsConfirmingLocal(true)
    setError(null)

    try {
      const decision = await applyPilotRosterSource(
        'confirmed-local',
        pendingLocalObservation,
        (request) => api.recordEncounter(request)
      )
      if (!decision.recorded) {
        setError(
          'Local not recorded: current system was unknown at check time. Refresh data and scan again.'
        )
        return
      }
      lastConfirmedLocalCandidateRef.current = candidateKey

      const watchlistPresence = reconcilePilotWatchlistPresence(
        presentWatchlistEntityKeysRef.current,
        watchlistRef.current,
        pendingLocalObservation.result
      )
      presentWatchlistEntityKeysRef.current = watchlistPresence.presentEntityKeys
      announceWatchlistEntries(
        watchlistPresence.entered.map(({ entry }) => entry),
        { kind: 'local' }
      )
      setPilotRosterSource('confirmed-local')
      const systemLabel = decision.request.currentSystem.name
        ?? `system ${decision.request.currentSystem.solarSystemId}`
      showNotice(`Local saved to Hunter · ${systemLabel}`)
    } catch (caught) {
      setError(`Could not save Local to Hunter: ${errorMessage(caught)}`)
    } finally {
      confirmingLocalRef.current = false
      setIsConfirmingLocal(false)
    }
  }, [
    announceWatchlistEntries,
    api,
    pendingLocalObservation,
    pilotRosterSource,
    showNotice
  ])

  const processClipboardText = useCallback(
    async (
      text: string,
      source: 'manual' | 'auto' = 'manual'
    ): Promise<'local' | 'dscan' | 'probe' | 'unknown'> => {
      const cleanText = text.trim()
      if (!cleanText) {
        if (source === 'manual') setError('Clipboard is empty.')
        return 'unknown'
      }

      const localPreview = parseLocalRoster(cleanText)
      const clipboardDetection = classifyEveClipboard(cleanText)
      const clipboardRoute = routeEveClipboard(cleanText)
      const clipboardNavigation = getClipboardNavigation(clipboardRoute)
      const deferLocalNavigation = shouldDeferAutomaticLocalNavigation(
        source,
        clipboardRoute,
        clipboardDetection.kind
      )
      const capturedNavigationSequence = workspaceNavigationSequenceRef.current
      clipboardOperationSequenceRef.current += 1
      const capturedClipboardOperationSequence = clipboardOperationSequenceRef.current

      if (clipboardRoute === 'local') {
        if (scanningRef.current) {
          if (source === 'manual') {
            lastClipboardRef.current = ''
            setError('A check for another character is already running. Try again in a few seconds.')
          }
          return 'local'
        }
        if (!deferLocalNavigation) {
          dscanSequenceRef.current += 1
          latestDscanCaptureRef.current = null
          setActiveClipboardMode('local')
          setTacticalClipboard(null)
          setResult(null)
          setRawText(text)
          setPreview(localPreview)
          if (clipboardNavigation) navigateToClipboard(clipboardNavigation.scrollTarget)
        }

        const outcome = await runScan(text, source, {
          stageOnly: deferLocalNavigation
        })
        const clipboardStillCurrent = deferLocalNavigation && outcome?.result.summary.resolved
          ? await api?.readClipboard()
            .then((currentText) => currentText.trim() === cleanText)
            .catch(() => false) ?? false
          : false
        if (
          deferLocalNavigation &&
          outcome &&
          clipboardNavigation &&
          shouldApplyDeferredLocalNavigation({
            resolvedPilots: outcome.result.summary.resolved,
            capturedNavigationSequence,
            currentNavigationSequence: workspaceNavigationSequenceRef.current,
            capturedClipboardOperationSequence,
            currentClipboardOperationSequence: clipboardOperationSequenceRef.current,
            automaticClipboardEnabled: autoClipboardRef.current,
            clipboardStillCurrent,
            activeWorkspace: activeWorkspaceRef.current
          })
        ) {
          dscanSequenceRef.current += 1
          latestDscanCaptureRef.current = null
          setActiveClipboardMode('local')
          setTacticalClipboard(null)
          setRawText(text)
          setPreview(localPreview)
          commitLocalScan(outcome, source)
          navigateToClipboard(clipboardNavigation.scrollTarget)
        }
        return 'local'
      }

      if (clipboardRoute === 'dscan') {
        const parsed = parseDscanClipboard(cleanText)
        if (parsed.rows.length === 0) return 'unknown'
        const capturedAt = new Date().toISOString()
        const capturedSystemId = currentClipboardSystemIdRef.current
        const sequence = dscanSequenceRef.current + 1
        dscanSequenceRef.current = sequence
        latestDscanCaptureRef.current = capturedAt
        const previousRows = previousDscanRowsRef.current?.map((row) => ({ ...row })) ?? null
        const intelligence = analyzeDscanIntelligence(parsed.rows, previousRows)
        previousDscanRowsRef.current = parsed.rows.map((row) => ({ ...row }))
        const typeIds = collectDscanTypeIds(parsed.rows)
        setActiveClipboardMode('dscan')
        setResult(null)
        setPilotRosterSource(null)
        setPendingLocalObservation(null)
        setRawText(text)
        setPreview({ names: [], rejected: 0 })
        setTacticalClipboard({
          kind: 'dscan',
          capturedAt,
          solarSystemId: capturedSystemId,
          rows: parsed.rows,
          rejected: parsed.rejected,
          intelligence,
          enrichmentPending: typeIds.length > 0 && Boolean(api),
          enrichmentWarning: typeIds.length > 0 && !api
            ? 'Type-name service unavailable; showing local labels.'
            : undefined
        })
        setError(null)
        if (clipboardNavigation) navigateToClipboard(clipboardNavigation.scrollTarget)
        showNotice(`D-scan: ${parsed.rows.length} objects`)
        recordEncounterSnapshot({
          capturedAt,
          dscanHulls: intelligence.composition.hulls.map((hull) => ({
            typeId: hull.typeId,
            typeName: hull.typeName,
            count: hull.count
          }))
        })

        if (typeIds.length > 0 && api) {
          void (async () => {
            try {
              const resolvedTypes = await api.resolveDscanTypeNames({ typeIds })
              if (
                dscanSequenceRef.current !== sequence ||
                latestDscanCaptureRef.current !== capturedAt
              ) return

              const enrichedRows = enrichDscanRows(parsed.rows, resolvedTypes)
              const enrichedIntelligence = analyzeDscanIntelligence(enrichedRows, previousRows)
              previousDscanRowsRef.current = enrichedRows.map((row) => ({ ...row }))
              setTacticalClipboard((current) => {
                if (current?.kind !== 'dscan' || current.capturedAt !== capturedAt) return current
                return {
                  ...current,
                  rows: enrichedRows,
                  intelligence: enrichedIntelligence,
                  enrichmentPending: false,
                  enrichmentWarning: resolvedTypes.length < typeIds.length
                    ? 'Some official type names were not found; showing local labels.'
                    : undefined
                }
              })
            } catch {
              // Optional ESI enrichment must never reject processClipboardText:
              // auto-clipboard keeps polling with the parsed snapshot visible.
              if (
                dscanSequenceRef.current !== sequence ||
                latestDscanCaptureRef.current !== capturedAt
              ) return
              setTacticalClipboard((current) => {
                if (current?.kind !== 'dscan' || current.capturedAt !== capturedAt) return current
                return {
                  ...current,
                  enrichmentPending: false,
                  enrichmentWarning: 'Could not load official type names; auto clipboard continues to work.'
                }
              })
            }
          })()
        }
        return 'dscan'
      }

      if (clipboardRoute === 'probe') {
        const parsed = parseProbeClipboard(cleanText)
        if (parsed.rows.length === 0) return 'unknown'
        const capturedAt = new Date().toISOString()
        const current = currentSystemSnapshotRef.current
        const solarSystemId = current?.location?.solarSystemId ?? null
        const systemName = current?.intel?.system.name ?? null
        dscanSequenceRef.current += 1
        latestDscanCaptureRef.current = null
        const previousProbeRows = solarSystemId !== null &&
          previousProbeSystemIdRef.current === solarSystemId
          ? previousProbeRowsRef.current
          : null
        const changes = compareProbeScans(previousProbeRows, parsed.rows)
        previousProbeRowsRef.current = parsed.rows.map((row) => ({ ...row }))
        previousProbeSystemIdRef.current = solarSystemId
        setActiveClipboardMode('probe')
        setResult(null)
        setPilotRosterSource(null)
        setPendingLocalObservation(null)
        setRawText(text)
        setPreview({ names: [], rejected: 0 })
        setTacticalClipboard({
          kind: 'probe',
          capturedAt,
          solarSystemId,
          systemName,
          rows: parsed.rows,
          rejected: parsed.rejected,
          changes
        })
        setError(null)
        if (clipboardNavigation) navigateToClipboard(clipboardNavigation.scrollTarget)
        showNotice(`Signatures: ${parsed.rows.length} results`)
        if (api && solarSystemId) {
          try {
            const observation = await api.recordProbeScan({
              solarSystemId,
              systemName: systemName ?? `System ${solarSystemId}`,
              rawProbeText: cleanText,
              observedAt: capturedAt
            })
            previousProbeSystemIdRef.current = observation.solarSystemId
            setTacticalClipboard((currentSnapshot) => (
              currentSnapshot?.kind === 'probe' && currentSnapshot.capturedAt === capturedAt
                ? {
                    ...currentSnapshot,
                    solarSystemId: observation.solarSystemId,
                    systemName: observation.systemName
                  }
                : currentSnapshot
            ))
            if (observation.solarSystemId !== solarSystemId) {
              showNotice(`ESI refreshed location: scan saved in ${observation.systemName}`)
            }
          } catch (caught) {
            showNotice(`Scan shown but not saved: ${errorMessage(caught)}`)
          }
        }
        if (api && proEnabled && solarSystemId && systemName) {
          await api.recordWormholeProbeScan({
            solarSystemId,
            systemName,
            rawProbeText: cleanText,
            observedAt: capturedAt
          }).catch(() => undefined)
        }
        return 'probe'
      }

      if (source === 'manual') {
        setError('Format not recognized. Copy Local, D-scan, or Probe Scanner signatures.')
      }
      return 'unknown'
    },
    [api, commitLocalScan, navigateToClipboard, proEnabled, recordEncounterSnapshot, runScan, showNotice]
  )

  useEffect(() => {
    if (!api || !autoClipboard) return

    let active = true
    let polling = false

    const pollClipboard = async (): Promise<void> => {
      if (!active || polling || scanningRef.current || confirmingLocalRef.current) return
      polling = true
      try {
        const clipboardText = await api.readClipboard()
        const decision = decideAutomaticClipboard(
          clipboardText,
          lastClipboardRef.current,
          activeWorkspaceRef.current
        )
        if (!active || !decision.changed) return

        lastClipboardRef.current = decision.normalizedText
        if (!decision.shouldProcess) return
        await processClipboardText(clipboardText, 'auto')
      } catch (caught) {
        if (active) {
          updateAutoClipboard(false)
          setError(`Auto clipboard stopped: ${errorMessage(caught)}`)
        }
      } finally {
        polling = false
      }
    }

    void pollClipboard()
    const interval = window.setInterval(() => void pollClipboard(), 1800)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [api, autoClipboard, processClipboardText, updateAutoClipboard])

  const handleClipboard = async (): Promise<void> => {
    if (!api || isReadingClipboard) return
    setIsReadingClipboard(true)
    setError(null)
    try {
      const clipboardText = await api.readClipboard()
      if (!clipboardText.trim()) {
        setError('Clipboard is empty. Copy Local, D-scan, or Probe Scanner signatures.')
        return
      }
      lastClipboardRef.current = clipboardText.trim()
      await processClipboardText(clipboardText, 'manual')
    } catch (caught) {
      setError(`Could not read clipboard: ${errorMessage(caught)}`)
    } finally {
      setIsReadingClipboard(false)
    }
  }

  const handleClearCache = async (): Promise<void> => {
    if (!api || isClearingCache) return
    setIsClearingCache(true)
    setError(null)
    try {
      await api.clearCache()
      const nextStatus = await api.getStatus()
      setStatus(nextStatus)
      showNotice('Cache cleared')
    } catch (caught) {
      setError(`Could not clear cache: ${errorMessage(caught)}`)
    } finally {
      setIsClearingCache(false)
    }
  }

  const contextualRiskEnabled = riskPriority !== 'general'

  useEffect(() => {
    if (!contextualRiskEnabled || !result || result.pilots.length === 0) return

    const generation = priorityEvidenceGenerationRef.current + 1
    priorityEvidenceGenerationRef.current = generation
    let cancelled = false
    const pilots = result.pilots
    setPriorityEvidenceByPilot(new Map(pilots.map((pilot) => [
      pilot.id,
      { status: 'loading' as const }
    ])))

    if (!api || typeof api.getRecentTargetProfile !== 'function') {
      setPriorityEvidenceByPilot(new Map(pilots.map((pilot) => [
        pilot.id,
        { status: 'error' as const, error: 'Update desktop client' }
      ])))
      return
    }

    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (!cancelled && generation === priorityEvidenceGenerationRef.current) {
        const index = nextIndex
        nextIndex += 1
        const pilot = pilots[index]
        if (!pilot) return

        try {
          const data = await api.getRecentTargetProfile({
            characterId: pilot.id,
            limit: 10
          })
          if (cancelled || generation !== priorityEvidenceGenerationRef.current) return
          setPriorityEvidenceByPilot((current) => {
            const next = new Map(current)
            next.set(pilot.id, { status: 'ready', data })
            return next
          })
        } catch (caught) {
          if (cancelled || generation !== priorityEvidenceGenerationRef.current) return
          setPriorityEvidenceByPilot((current) => {
            const next = new Map(current)
            next.set(pilot.id, { status: 'error', error: errorMessage(caught) })
            return next
          })
        }
      }
    }

    void Promise.all(Array.from(
      { length: Math.min(3, pilots.length) },
      () => worker()
    ))

    return () => {
      cancelled = true
    }
  }, [api, contextualRiskEnabled, result])

  const handleSort = (nextKey: SortKey): void => {
    if (nextKey === sortKey) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(nextKey)
    setSortDirection(
      nextKey === 'name' || nextKey === 'corporation' || nextKey === 'alliance'
        ? 'asc'
        : 'desc'
    )
  }

  const priorityAssessmentByPilot = useMemo(() => {
    const assessments = new Map<number, PriorityRiskAssessment>()
    if (!result || riskPriority === 'general') return assessments

    for (const pilot of result.pilots) {
      const evidence = priorityEvidenceByPilot.get(pilot.id)
      assessments.set(pilot.id, assessPriorityRisk({
        category: riskPriority,
        lifetimeProfile: pilot.stats?.targetProfile,
        baseThreatScore: pilot.threatScore,
        recent: evidence?.data,
        evidenceStatus: evidence?.status ?? 'idle'
      }))
    }
    return assessments
  }, [priorityEvidenceByPilot, result, riskPriority])

  const effectivePilots = useMemo(() => {
    if (!result || riskPriority === 'general') return result?.pilots ?? []
    return result.pilots.map((pilot) => {
      const assessment = priorityAssessmentByPilot.get(pilot.id)
      return assessment
        ? {
            ...pilot,
            threatScore: assessment.score,
            threatLevel: assessment.level,
            reasons: assessment.reasons
          }
        : pilot
    })
  }, [priorityAssessmentByPilot, result, riskPriority])

  const genericPilotById = useMemo(
    () => new Map(result?.pilots.map((pilot) => [pilot.id, pilot]) ?? []),
    [result]
  )

  const priorityEvidenceProgress = useMemo(() => {
    if (!result || riskPriority === 'general') {
      return { loaded: 0, total: result?.pilots.length ?? 0, loading: false }
    }
    const states = result.pilots.map((pilot) => priorityEvidenceByPilot.get(pilot.id)?.status)
    return {
      loaded: states.filter((state) => state === 'ready' || state === 'error').length,
      total: states.length,
      loading: states.some((state) => state === 'loading' || state === undefined)
    }
  }, [priorityEvidenceByPilot, result, riskPriority])

  const effectiveDangerousCount = effectivePilots.filter(
    (pilot) => pilot.threatLevel === 'critical' || pilot.threatLevel === 'high'
  ).length
  const effectiveUnknownCount = (result?.unresolvedNames.length ?? 0) + effectivePilots.filter(
    (pilot) => pilot.threatLevel === 'unknown'
  ).length

  const visiblePilots = useMemo(() => {
    if (!result) return []
    const normalizedQuery = query.trim().toLocaleLowerCase('ru')
    const filtered = effectivePilots.filter((pilot) => {
      if (threatFilter !== 'all' && pilot.threatLevel !== threatFilter) return false
      if (!normalizedQuery) return true
      return [
        pilot.name,
        pilot.corporationName,
        pilot.allianceName,
        ...(pilot.relationship?.labelNames ?? [])
      ]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase('ru').includes(normalizedQuery))
    })
    return sortPilots(filtered, sortKey, sortDirection)
  }, [effectivePilots, query, result, sortDirection, sortKey, threatFilter])

  const currentWatchlistMatches = useMemo(
    () => result ? findPilotWatchlistMatches(watchlist.entries, result) : [],
    [result, watchlist.entries]
  )
  const currentWatchlistMatchIds = useMemo(
    () => new Set(result
      ? findPilotWatchlistMatchedPilotIds(watchlist.entries, result)
      : []),
    [result, watchlist.entries]
  )

  const filterCount = useCallback(
    (filter: ThreatFilter): number => {
      if (!result) return 0
      if (filter === 'all') return effectivePilots.length
      return effectivePilots.filter((pilot) => pilot.threatLevel === filter).length
    },
    [effectivePilots, result]
  )

  const progressPercent =
    progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : 0
  const inputDetection = useMemo(() => classifyEveClipboard(rawText), [rawText])
  const inputKindLabel = inputDetection.kind === 'dscan'
    ? 'D-scan'
    : inputDetection.kind === 'probe'
      ? 'Signatures'
      : preview.names.length > 0
        ? 'Pilot names'
        : 'Auto-detect'
  const inputActionLabel = inputDetection.kind === 'dscan' || inputDetection.kind === 'probe'
    ? 'Parse scan'
    : 'Check pilots'
  const confirmedLocal = pilotRosterSource === 'confirmed-local'
  const observationSystemId = pendingLocalObservation?.systemSnapshot?.location?.solarSystemId ?? null
  const observationSystemName = observationSystemId !== null &&
    pendingLocalObservation?.systemSnapshot?.intel?.system.id === observationSystemId
    ? pendingLocalObservation.systemSnapshot.intel.system.name
    : null
  const clipboardVisibility = getClipboardViewVisibility(
    activeClipboardMode,
    result !== null,
    isScanning
  )

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <RadarIcon />
          </div>
          <div>
            <div className="brand-heading">
              <div className="brand-title">
                FLY <span>SAFE</span>
              </div>
              <span
                className={`app-version-badge ${status ? '' : 'loading'}`}
                aria-label={status
                  ? `App version ${status.version}`
                  : 'Loading app version'}
              >
                {formatAppVersion(status?.version)}
              </span>
            </div>
            <p>Local threat assessment for Windows and macOS</p>
          </div>
        </div>
        <div className="topbar-actions">
          <div className={`service-state ${api ? 'online' : 'offline'}`}>
            <span aria-hidden="true" />
            {api ? 'Local database' : 'Disconnected'}
          </div>
          <span className="cache-count" title={status?.databasePath}>
            Cache: {status?.cacheEntries ?? '—'}
          </span>
          <button
            type="button"
            className="text-button"
            onClick={() => void handleClearCache()}
            disabled={!api || isClearingCache}
          >
            {isClearingCache ? 'Clearing…' : 'Clear cache'}
          </button>
        </div>
      </header>

      <nav className="workspace-navigation" aria-label="Main sections">
        {proEnabled ? <button
          type="button"
          className={activeWorkspace === 'pro' ? 'active' : ''}
          aria-current={activeWorkspace === 'pro' ? 'page' : undefined}
          onClick={() => switchWorkspace('pro')}
        >
          Pro
        </button> : null}
        <button
          type="button"
          className={activeWorkspace === 'intel' ? 'active' : ''}
          aria-current={activeWorkspace === 'intel' ? 'page' : undefined}
          onClick={() => switchWorkspace('intel')}
        >
          Intel
        </button>
        <button
          type="button"
          className={activeWorkspace === 'market' ? 'active' : ''}
          aria-current={activeWorkspace === 'market' ? 'page' : undefined}
          onClick={() => switchWorkspace('market')}
        >
          Market
        </button>
        <button type="button" className={activeWorkspace === 'industry' ? 'active' : ''} aria-current={activeWorkspace === 'industry' ? 'page' : undefined} onClick={() => switchWorkspace('industry')}>Производство</button>
        <button type="button" className={activeWorkspace === 'production' ? 'active' : ''} aria-current={activeWorkspace === 'production' ? 'page' : undefined} onClick={() => switchWorkspace('production')}>Готовая продукция</button>
        <button
          type="button"
          className={activeWorkspace === 'route' ? 'active' : ''}
          aria-current={activeWorkspace === 'route' ? 'page' : undefined}
          onClick={() => switchWorkspace('route')}
        >
          Route
        </button>
        <button
          type="button"
          className={activeWorkspace === 'watchlist' ? 'active' : ''}
          aria-current={activeWorkspace === 'watchlist' ? 'page' : undefined}
          onClick={() => switchWorkspace('watchlist')}
        >
          Contacts
          <span className="workspace-count">{watchlist.entries.length}</span>
        </button>
        <button
          type="button"
          className={activeWorkspace === 'journal' ? 'active' : ''}
          aria-current={activeWorkspace === 'journal' ? 'page' : undefined}
          onClick={() => switchWorkspace('journal')}
        >
          Journal
        </button>
        <button
          type="button"
          className={activeWorkspace === 'finance' ? 'active' : ''}
          aria-current={activeWorkspace === 'finance' ? 'page' : undefined}
          onClick={() => switchWorkspace('finance')}
        >
          Finances
        </button>
        <button
          type="button"
          className={activeWorkspace === 'settings' ? 'active' : ''}
          aria-current={activeWorkspace === 'settings' ? 'page' : undefined}
          onClick={() => switchWorkspace('settings')}
        >
          Settings
        </button>
        {selectedPilot && (
          <>
            <button
              type="button"
              className={`pilot-navigation-tab ${activeWorkspace === 'pilot' ? 'active' : ''}`}
              aria-current={activeWorkspace === 'pilot' ? 'page' : undefined}
              onClick={() => switchWorkspace('pilot')}
              title={selectedPilot.name ?? `Pilot ${selectedPilot.characterId}`}
            >
              Pilot · {selectedPilot.name ?? selectedPilot.characterId}
            </button>
            <button
              type="button"
              className="pilot-navigation-close"
              onClick={handleClosePilot}
              aria-label="Close pilot tab"
              title="Close pilot tab"
            >
              ×
            </button>
          </>
        )}
      </nav>

      <main
        id="intel-workspace"
        className="workspace"
        hidden={activeWorkspace !== 'intel'}
      >
        <SystemIntelPanel
          api={api}
          onSnapshotChange={handleCurrentSystemSnapshot}
          pollingActive
          onOpenPilot={handleOpenPilot}
          watchlistById={watchlistById}
          watchlistPendingEntityKeys={watchlistPendingEntityKeys}
          onToggleWatchlist={(pilot) => void togglePilotWatchlist(pilot)}
          currentSystemPollIntervalMs={pollingIntervals.currentSystem}
          pilotContextPollIntervalMs={pollingIntervals.pilotContext}
          pollInBackground={uiSettings.backgroundNotificationsEnabled}
          onKillAlertsObserved={handleKillAlertsObserved}
          onPilotContextChange={setPilotContextForImport}
          additionalKillAlertSystemIds={routeCorridorSystemIds}
        />

        <NearbyPvePanel
          api={api}
          currentSystemId={currentSystemSnapshot?.location?.solarSystemId ?? null}
        />

        <section
          ref={clipboardInputRef}
          className="input-panel clipboard-scroll-target"
          aria-labelledby="local-list-title"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Clipboard Intel · format: {inputKindLabel}</p>
              <h1 id="local-list-title">Pilots, Local, D-scan, or signatures</h1>
            </div>
            <label className="auto-toggle">
              <span className="toggle-copy">
                <strong>Auto clipboard</strong>
                <small>opens results after {COPY_SHORTCUT} · never captures market or system text</small>
              </span>
              <input
                type="checkbox"
                checked={autoClipboard}
                onChange={(event) => {
                  updateAutoClipboard(event.target.checked)
                  if (event.target.checked) {
                    lastClipboardRef.current = ''
                    setError(null)
                  }
                }}
                disabled={!api || isConfirmingLocal}
              />
              <span className="switch" aria-hidden="true" />
            </label>
          </div>

          <div className="textarea-wrap">
            <textarea
              value={rawText}
              onChange={(event) => {
                setRawText(event.target.value)
                if (activeClipboardMode === 'local' && result !== null) {
                  setResult(null)
                  setPilotRosterSource(null)
                  setPendingLocalObservation(null)
                  setActiveClipboardMode(null)
                }
              }}
              placeholder={'Character name or pilot list:\nPilot One\nPilot Two\n\nor D-scan lines / Probe Scanner signatures'}
              aria-label="Character name, pilot list, Local, D-scan, or Probe Scanner signatures"
              spellCheck={false}
              disabled={isScanning || isConfirmingLocal}
            />
            <div className="textarea-meta" aria-live="polite">
              <span>
                {preview.names.length > 0
                  ? `Pilots recognized: ${preview.names.length}`
                  : inputDetection.rowCount > 0
                    ? `Rows recognized: ${inputDetection.rowCount}`
                    : 'Supports Local, D-scan, and Probe Scanner signatures'}
              </span>
              {preview.rejected > 0 && <span>Skipped: {preview.rejected}</span>}
            </div>
          </div>

          <div className="input-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleClipboard()}
              disabled={!api || isScanning || isReadingClipboard || isConfirmingLocal}
            >
              <ClipboardIcon />
              {isReadingClipboard ? 'Reading…' : 'Read clipboard'}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => void processClipboardText(rawText, 'manual')}
              disabled={!api || isScanning || isConfirmingLocal || rawText.trim().length === 0}
            >
              <RadarIcon />
              {isScanning ? 'Analyzing…' : inputActionLabel}
            </button>
          </div>
        </section>

        <div
          ref={clipboardResultRef}
          className="clipboard-current-result clipboard-scroll-target"
          role="region"
          aria-label="Current Clipboard Intel result"
        >
        {clipboardVisibility.showTacticalResult &&
          tacticalClipboard?.kind === activeClipboardMode && (
          <>
            {tacticalClipboard.kind === 'dscan' && (
              <DscanKillboardCorrelationPanel
                snapshot={tacticalClipboard}
                currentSystem={currentSystemSnapshot}
                onOpenPilot={handleOpenPilot}
                watchlistById={watchlistById}
                watchlistPendingEntityKeys={watchlistPendingEntityKeys}
                onToggleWatchlist={(pilot) => void togglePilotWatchlist(pilot)}
                onCandidatesObserved={handleDscanCandidatesObserved}
              />
            )}
            <ClipboardIntelPanel snapshot={tacticalClipboard} />
          </>
        )}

        {activeClipboardMode === 'local' && isScanning && (
          <section className="progress-panel" aria-live="polite" aria-label="Analysis progress">
            <div className="progress-copy">
              <div>
                <span className="pulse-dot" aria-hidden="true" />
                <strong>Collecting intel</strong>
              </div>
              <span>
                {progress.total > 0
                  ? `${progress.completed} / ${progress.total}`
                  : 'Preparing…'}
              </span>
            </div>
            <div
              className="progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={progress.total || undefined}
              aria-valuenow={progress.total ? progress.completed : undefined}
            >
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <p>
              {progress.total > 0 && progress.completed >= progress.total
                ? 'Combat data ready · checking contacts and relationships'
                : progress.currentName
                  ? `Ready: ${progress.currentName}`
                  : 'Querying ESI and combat-statistics sources'}
            </p>
          </section>
        )}

        {activeClipboardMode === 'local' && isScanning && readyPilots.length > 0 && (
          <ProgressivePilotRows pilots={readyPilots} />
        )}

        {error && (
          <section className="alert error-alert" role="alert">
            <WarningIcon />
            <div>
              <strong>Error</strong>
              <p>{error}</p>
            </div>
            <button type="button" onClick={() => setError(null)} aria-label="Close error">
              ×
            </button>
          </section>
        )}

        {notice && (
          <div className="toast" role="status">
            <span aria-hidden="true">✓</span>
            {notice}
          </div>
        )}

        {clipboardVisibility.showLocalResult && result ? (
          <>
            <PilotRosterObservationCard
              source={pilotRosterSource ?? 'lookup'}
              systemId={observationSystemId}
              systemName={observationSystemName}
              confirming={isConfirmingLocal}
              onConfirm={() => void confirmLocalObservation()}
            />
            {currentWatchlistMatches.length > 0 && (
              <section className="watchlist-hit-alert" role={confirmedLocal ? 'alert' : 'status'}>
                <span aria-hidden="true">⚠</span>
                <div>
                  <strong>
                    {confirmedLocal
                      ? currentWatchlistMatches.length === 1
                        ? 'Dangerous contact found in Local'
                        : `Dangerous contacts found in Local: ${currentWatchlistMatches.length}`
                      : currentWatchlistMatches.length === 1
                        ? 'Pilot found on the watchlist'
                        : `Pilots found on the watchlist: ${currentWatchlistMatches.length}`}
                  </strong>
                  <small>
                    {currentWatchlistMatches.map(({ entry }) =>
                      entry.note ? `${entry.name} — ${entry.note}` : entry.name
                    ).join(' · ')}
                  </small>
                </div>
              </section>
            )}
            <section className="summary-grid" aria-label="Scan summary">
              <SummaryCard label={confirmedLocal ? 'Total in Local' : 'Checked'} value={result.summary.total} detail={`${result.summary.resolved} identified`} tone="neutral" />
              <SummaryCard
                label={riskPriority === 'general'
                  ? 'Dangerous'
                  : `Dangerous to ${riskPriorityTargetLabel(riskPriority)}`}
                value={effectiveDangerousCount}
                detail={riskPriority === 'general'
                  ? 'high and critical threat'
                  : 'for the selected victim type'}
                tone="danger"
              />
              <SummaryCard label="No data" value={effectiveUnknownCount} detail="manual verification needed" tone="warning" />
              <SummaryCard label="From cache" value={result.summary.cached} detail={`scan in ${formatDuration(result.summary.durationMs)}`} tone="info" />
            </section>

            <section className="intel-panel" aria-labelledby="intel-title">
              <div className="intel-header">
                <div>
                  <p className="eyebrow">Intel</p>
                  <h2 id="intel-title">Pilots</h2>
                </div>
                <div className="intel-header-tools">
                  <div className="scan-stamp">
                    {new Date(result.scannedAt).toLocaleTimeString('en-US', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </div>
                </div>
              </div>

              <div className="risk-priority-bar">
                <div className="risk-priority-copy">
                  <strong>Risk by victim type</strong>
                  <span>
                    Choose what the pilot usually destroys. Their own ship is not counted.
                  </span>
                </div>
                <PriorityRiskControl
                  value={riskPriority}
                  onChange={updateRiskPriority}
                  loaded={priorityEvidenceProgress.loaded}
                  total={priorityEvidenceProgress.total}
                  loading={priorityEvidenceProgress.loading}
                />
              </div>

              <div className="toolbar">
                <label className="search-field">
                  <span className="sr-only">Search pilots</span>
                  <SearchIcon />
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Pilot, corporation, alliance…"
                  />
                  {query && (
                    <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
                      ×
                    </button>
                  )}
                </label>
                <div className="filter-tabs" role="group" aria-label="Threat-level filter">
                  {FILTERS.map((filter) => (
                    <button
                      key={filter.value}
                      type="button"
                      className={threatFilter === filter.value ? 'active' : ''}
                      onClick={() => setThreatFilter(filter.value)}
                      aria-pressed={threatFilter === filter.value}
                    >
                      {filter.label}
                      <span>{filterCount(filter.value)}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <SortHeader label="Pilot" sortKey="name" activeKey={sortKey} direction={sortDirection} onSort={handleSort} />
                      <SortHeader label="Corporation" sortKey="corporation" activeKey={sortKey} direction={sortDirection} onSort={handleSort} />
                      <SortHeader label="Alliance" sortKey="alliance" activeKey={sortKey} direction={sortDirection} onSort={handleSort} />
                      <SortHeader
                        label={riskPriority === 'general' ? 'Risk' : `Risk · ${riskPriorityLabel(riskPriority)}`}
                        sortKey="risk"
                        activeKey={sortKey}
                        direction={sortDirection}
                        onSort={handleSort}
                      />
                      <SortHeader label="Kills" sortKey="kills" activeKey={sortKey} direction={sortDirection} align="right" onSort={handleSort} />
                      <SortHeader label="Losses" sortKey="losses" activeKey={sortKey} direction={sortDirection} align="right" onSort={handleSort} />
                      <SortHeader label="Solo" sortKey="solo" activeKey={sortKey} direction={sortDirection} align="right" onSort={handleSort} />
                      <SortHeader label="Gang" sortKey="gang" activeKey={sortKey} direction={sortDirection} align="right" onSort={handleSort} />
                      <SortHeader label="ISK" sortKey="isk" activeKey={sortKey} direction={sortDirection} align="right" onSort={handleSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePilots.map((pilot) => {
                      const watchlisted = watchlistById.has(pilot.id)
                      const watchlistMatch = currentWatchlistMatchIds.has(pilot.id)
                      const priorityAssessment = priorityAssessmentByPilot.get(pilot.id)
                      const priorityEvidence = priorityEvidenceByPilot.get(pilot.id)
                      const genericPilot = genericPilotById.get(pilot.id)
                      const riskTitle = priorityAssessment
                        ? [
                            ...priorityAssessment.reasons,
                            `Overall PvP risk: ${genericPilot?.threatScore ?? '—'}`
                          ].join(' • ')
                        : pilot.reasons.join(' • ') || THREAT_LABELS[pilot.threatLevel]
                      const openFullPilot = (): void => handleOpenPilot({
                        characterId: pilot.id,
                        name: pilot.name,
                        sourceLabel: confirmedLocal ? 'Local Intel' : 'Pilot check',
                        initialPilot: pilot
                      })

                      return (
                          <tr
                            className={`threat-row ${pilot.threatLevel} ${watchlistMatch ? 'watchlist-hit' : ''}`}
                            key={pilot.id}
                          >
                            <td className="pilot-cell">
                              <PilotIntelIdentityCell
                                pilot={pilot}
                                watchlisted={watchlisted}
                                watchlistMatch={watchlistMatch}
                                favoritePending={watchlistPendingEntityKeys.has(
                                  toPilotWatchlistEntityKey('character', pilot.id)
                                )}
                                onOpen={openFullPilot}
                                onToggleFavorite={(candidate) => void togglePilotWatchlist(candidate)}
                              />
                            </td>
                            <td title={pilot.corporationName ?? undefined}>{pilot.corporationName ?? '—'}</td>
                            <td title={pilot.allianceName ?? undefined}>{pilot.allianceName ?? '—'}</td>
                            <td>
                              <div className="priority-risk-cell">
                                <div className={`threat-badge ${pilot.threatLevel}`} title={riskTitle}>
                                  <span>{THREAT_LABELS[pilot.threatLevel]}</span>
                                  {pilot.threatLevel !== 'unknown' && <b>{pilot.threatScore}</b>}
                                </div>
                                {priorityAssessment && (
                                  <small title={priorityEvidence?.error}>
                                    {formatPriorityRiskEvidence(
                                      priorityAssessment,
                                      priorityEvidence?.status ?? 'idle'
                                    )}
                                  </small>
                                )}
                              </div>
                            </td>
                            <td className="numeric">{pilot.stats?.shipsDestroyed ?? '—'}</td>
                            <td className="numeric">{pilot.stats?.shipsLost ?? '—'}</td>
                            <td className="numeric">{formatPercent(pilot.stats?.soloRatio)}</td>
                            <td className="numeric">{formatPercent(pilot.stats?.gangRatio)}</td>
                            <td className="numeric isk-cell">{formatIsk(pilot.stats?.iskDestroyed)}</td>
                          </tr>
                      )
                    })}
                  </tbody>
                </table>
                {visiblePilots.length === 0 && (
                  <div className="no-results">
                    <SearchIcon />
                    <strong>Nothing found</strong>
                    <p>Clear the search or choose a different threat level.</p>
                  </div>
                )}
              </div>
              <div className="table-footer">
                <span>Showing {visiblePilots.length} of {result.pilots.length}</span>
                <span>
                  {riskPriority === 'general'
                    ? 'The assessment is guidance, not a guarantee of intent'
                    : `Risk by victims: ${riskPriorityLabel(riskPriority)} · not the pilot’s current ship`}
                </span>
              </div>
            </section>

            {(result.unresolvedNames.length > 0 || result.warnings.length > 0) && (
              <section className="diagnostics" aria-label="Warnings and unidentified names">
                {result.unresolvedNames.length > 0 && (
                  <article>
                    <div className="diagnostic-title">
                      <span className="diagnostic-icon">···</span>
                      <div><strong>Unidentified</strong><small>{result.unresolvedNames.length} names</small></div>
                    </div>
                    <div className="name-chips">
                      {result.unresolvedNames.map((name) => <span key={name}>{name}</span>)}
                    </div>
                  </article>
                )}
                {result.warnings.length > 0 && (
                  <article>
                    <div className="diagnostic-title">
                      <span className="diagnostic-icon warning"><WarningIcon /></span>
                      <div><strong>Warnings</strong><small>some data may be incomplete</small></div>
                    </div>
                    <ul>
                      {result.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
                    </ul>
                  </article>
                )}
              </section>
            )}
          </>
        ) : (
          clipboardVisibility.showEmptyState && (
            <section className="empty-state">
              <div className="radar-visual" aria-hidden="true">
                <span className="radar-ring ring-one" />
                <span className="radar-ring ring-two" />
                <span className="radar-ring ring-three" />
                <span className="radar-sweep" />
                <span className="radar-contact contact-one" />
                <span className="radar-contact contact-two" />
                <span className="radar-contact contact-three" />
              </div>
              <div>
                <p className="eyebrow">Ready to scan</p>
                <h2>Check a pilot or Local</h2>
                <p>A regular check is not added to Hunter. You can add an actual Local list after analysis.</p>
                <ol>
                  <li><span>1</span>Copy a pilot name or names from Local</li>
                  <li><span>2</span>Press {COPY_SHORTCUT}</li>
                  <li><span>3</span>Review and confirm Local if needed</li>
                </ol>
              </div>
            </section>
          )
        )}
        </div>

      </main>

      <main
        id="market-workspace"
        className="workspace feature-workspace"
        hidden={activeWorkspace !== 'market'}
      >
        <MarketWorkspace api={api} active={activeWorkspace === 'market'} />
      </main>

      <main id="industry-workspace" className="workspace feature-workspace" hidden={activeWorkspace !== 'industry'}>
        <IndustryWorkspace api={api} active={activeWorkspace === 'industry'} />
      </main>
      <main id="production-workspace" className="workspace feature-workspace" hidden={activeWorkspace !== 'production'}>
        <IndustryProductionWorkspace api={api} active={activeWorkspace === 'production'} />
      </main>

      <main
        id="route-workspace"
        className="workspace feature-workspace"
        hidden={activeWorkspace !== 'route'}
      >
        <RouteWorkspace
          api={api}
          active={activeWorkspace === 'route'}
          currentSystemId={currentSystemSnapshot?.location?.solarSystemId ?? null}
          currentSystemName={currentSystemSnapshot?.intel?.system.name ?? null}
          onResultChange={handleRouteResult}
        />
      </main>

      <main
        id="journal-workspace"
        className="workspace feature-workspace"
        hidden={activeWorkspace !== 'journal'}
      >
        <JournalWorkspace
          api={api}
          active={activeWorkspace === 'journal'}
          onOpenPilot={handleOpenPilot}
        />
      </main>

      <main
        id="finance-workspace"
        className="workspace feature-workspace"
        hidden={activeWorkspace !== 'finance'}
      >
        <FinanceWorkspace api={api} active={activeWorkspace === 'finance'} />
      </main>

      {proEnabled ? <main
        id="pro-workspace"
        className="workspace feature-workspace"
        hidden={activeWorkspace !== 'pro'}
      >
        <ProWorkspace
          api={api}
          currentSystem={currentSystemSnapshot?.location && currentSystemSnapshot.intel
            ? {
                solarSystemId: currentSystemSnapshot.location.solarSystemId,
                name: currentSystemSnapshot.intel.system.name
              }
            : null}
          onRequestCharacterConnect={async () => { await api?.connectAccount() }}
          features={entitlementFeatures}
        />
      </main> : null}

      <main
        id="settings-workspace"
        className="workspace feature-workspace"
        hidden={activeWorkspace !== 'settings'}
      >
        <SettingsWorkspace
          api={api}
          onApplied={applyUiSettings}
          onTestSound={(volumePercent) => playPilotWatchlistAlert(volumePercent)}
        />
      </main>

      <main
        id="watchlist-workspace"
        className="workspace watchlist-workspace"
        hidden={activeWorkspace !== 'watchlist'}
      >
        {error && (
          <section className="alert error-alert" role="alert">
            <WarningIcon />
            <div>
              <strong>Error</strong>
              <p>{error}</p>
            </div>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
              ×
            </button>
          </section>
        )}
        {notice && (
          <div className="toast" role="status">
            <span aria-hidden="true">✓</span>
            {notice}
          </div>
        )}
        <PilotWatchlistPanel
          entries={watchlist.entries}
          loading={watchlistLoading}
          pendingEntityKeys={watchlistPendingEntityKeys}
          soundEnabled={watchlistSoundEnabled}
          onSoundEnabledChange={setWatchlistSoundEnabled}
          onTestSound={testWatchlistSound}
          onOpenPilot={(entry) => handleOpenPilot({
            characterId: getPilotWatchlistEntityId(entry),
            name: entry.name,
            sourceLabel: 'Watchlist'
          })}
          onUpdate={(entry, patch) => void updatePilotWatchlist(entry, patch)}
          onAdvancedUpdate={(entry, patch) => void updateAdvancedWatchlist(entry, patch)}
          onCreateEntity={(request) => void createWatchlistEntity(request)}
          onRemove={(entry) => void removePilotWatchlistEntry(entry)}
          eveContactImportCount={eveContactImportCount}
          onImportEveContacts={() => void importEveContacts()}
          importingEveContacts={importingEveContacts}
        />
      </main>

      {selectedPilot && (
        <main
          id="pilot-workspace"
          className="workspace pilot-workspace"
          hidden={activeWorkspace !== 'pilot'}
        >
          {error && (
            <section className="alert error-alert" role="alert">
              <WarningIcon />
              <div>
                <strong>Error</strong>
                <p>{error}</p>
              </div>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
                ×
              </button>
            </section>
          )}
          {notice && (
            <div className="toast" role="status">
              <span aria-hidden="true">✓</span>
              {notice}
            </div>
          )}
          <PilotWorkspacePanel
            key={selectedPilot.characterId}
            api={api}
            selection={selectedPilot}
            onBack={handleReturnFromPilot}
            onClose={handleClosePilot}
            watchlisted={watchlistById.has(selectedPilot.characterId)}
            watchlistPending={watchlistPendingEntityKeys.has(
              toPilotWatchlistEntityKey('character', selectedPilot.characterId)
            )}
            onToggleWatchlist={(pilot) => void togglePilotWatchlist(pilot)}
            onOpenPilot={handleOpenPilot}
          />
        </main>
      )}

      <footer className="app-footer">
        <span>Fly Safe {formatAppVersion(status?.version)}</span>
        <span>Data from ESI and public combat statistics</span>
      </footer>
    </div>
  )
}
