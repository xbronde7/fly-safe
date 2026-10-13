import type { TargetProfile } from './target-profile'
import type { ShipFit } from './killmail-fit'
import type { SystemIntel } from './system-intel'
import type { KillAlertPollRequest, KillAlertPollResponse } from './kill-alert'
import type { DscanTypeName, DscanTypeNameRequest } from './clipboard-intel'
import type {
  PilotClassification,
  PilotContext,
  PilotContextQuery
} from './pilot-context'
import type {
  PilotWatchlistRemoveRequest,
  PilotWatchlistSnapshot,
  PilotWatchlistUpsertRequest
} from './pilot-watchlist'
import type {
  MarketAppraisal,
  MarketAppraisalRequest,
  MarketComparisonRequest,
  MarketHubComparison,
  MarketTypeSearchMatch
} from './market'
import type {
  RouteIntelRequest,
  RouteIntelResult,
  RouteWaypointRequest,
  RouteWaypointResult
} from './route-intel'
import type { PersonalEconomySnapshot } from './personal-economy'
import type { IndustryCharacterSnapshot, IndustryScanRequest, IndustryScanResult, IndustryScanProgress, IndustryFactoryRequest, IndustryFactoryResult, IndustryLiquidityRequest, IndustryLiquidity } from './industry'
import type { IndustryLedgerSnapshot } from './industry-ledger'
import type { IndustryMonitorConfig, IndustryMonitorSnapshot } from './industry-monitor'
import type { IndustryProductionCost, IndustryProductionSnapshot } from './industry-production'
import type {
  NativeAlertRequest,
  NativeAlertResult,
  NativeAlertWorkspace,
  TrayStatus
} from './native-alert'
import type {
  UiSettingsSnapshot,
  UiSettingsUpdateRequest
} from './ui-settings'
import type {
  EncounterJournalPage,
  EncounterPilotSearchPage,
  EncounterPilotSearchQuery,
  EncounterRecentQuery,
  EncounterSnapshot,
  EncounterSnapshotInput
} from './encounter-journal'
import type {
  WormholeChain,
  WormholeConnection,
  WormholeConnectionUpsertInput,
  WormholeProbeScanRecordRequest,
  WormholeSystemNode,
  WormholeSystemUpsertInput
} from './wormhole-chain'
import type {
  DoctrineMatchResult,
  DoctrineTemplate,
  DoctrineTemplateInput
} from './doctrine-matcher'
import type { HunterPlan, HunterPlanRequest } from './hunter-planner'
import type {
  MarketOpportunityEvaluationRequest,
  MarketOpportunityRadar
} from './market-opportunity'
import type { EveMultiAccountStatus } from './multi-account'
import type {
  SharedWorkspaceMutation,
  SharedWorkspaceMutationResult,
  SharedWorkspaceRole,
  SharedWorkspaceShareScope,
  SharedWorkspaceSnapshot,
  SharedWorkspaceSummary
} from './shared-workspace'
import type {
  NearbyAnomalyRequest,
  NearbyAnomalySnapshot,
  ProbeScanRecordRequest,
  ProbeSystemObservation
} from './nearby-anomalies'
import type { NearbyPveRequest, NearbyPveSnapshot } from './nearby-pve'

export type { TargetCategory, TargetProfile, TargetProfileEntry } from './target-profile'
export type { FitItem, FitSection, ShipFit } from './killmail-fit'
export type { DscanTypeName, DscanTypeNameRequest } from './clipboard-intel'
export type {
  EveCharacterAccountStatus,
  EveCharacterSelectionRequest,
  EveLegacyMigrationState,
  EveMultiAccountState,
  EveMultiAccountStatus
} from './multi-account'
export type {
  SharedWorkspaceMutation,
  SharedWorkspaceMutationResult,
  SharedWorkspaceRole,
  SharedWorkspaceShareScope,
  SharedWorkspaceSnapshot,
  SharedWorkspaceSummary
} from './shared-workspace'
export type {
  AnomalyObservationFreshness,
  AnomalySiteSummary,
  NearbyAnomalyRequest,
  NearbyAnomalySnapshot,
  NearbyAnomalySystem,
  ProbeScanRecordRequest,
  ProbeSystemObservation
} from './nearby-anomalies'
export type {
  NearbyPveActivity,
  NearbyPveRequest,
  NearbyPveSnapshot,
  NearbyPveSystem
} from './nearby-pve'
export type {
  KillAlert,
  KillAlertAttacker,
  KillAlertParticipant,
  KillAlertPollRequest,
  KillAlertPollResponse,
  KillAlertShipClassification,
  KillAlertVictim,
  ParsedR2z2Killmail
} from './kill-alert'
export type {
  FriendlyFleetContext,
  FriendlyFleetMember,
  FriendlyFleetRole,
  PilotClassification,
  PilotContact,
  PilotContactLabel,
  PilotContactsContext,
  PilotContactType,
  PilotContext,
  PilotContextQuery,
  PilotIdentity,
  PilotStandingClass
} from './pilot-context'
export type {
  ParsedSystemAttacker,
  ParsedSystemKillmail,
  SystemDangerAssessment,
  SystemDangerFactor,
  SystemDangerInput,
  SystemDangerLevel,
  SystemHistoryFacts,
  SystemHistoryLimits,
  SystemIntel,
  SystemIntelRequest,
  SystemKillmailObservation,
  SystemLastHourActivity,
  SystemMetadata,
  SystemObservedPilot,
  SystemObservedShip,
  SystemObservedShipOccurrence,
  SystemObservedShipPilot,
  SystemZkillHistory
} from './system-intel'
export type {
  PilotWatchlistEntry,
  PilotWatchlistEntityKey,
  PilotWatchlistMatch,
  PilotWatchlistPresence,
  PilotWatchlistRemoveRequest,
  PilotWatchlistSnapshot,
  PilotWatchlistUpsertRequest
} from './pilot-watchlist'
export type {
  MarketAppraisal,
  MarketAppraisalHubTotal,
  MarketAppraisalItem,
  MarketAppraisalRequest,
  MarketBookSummary,
  MarketComparisonRequest,
  MarketHistoryPoint,
  MarketHistorySummary,
  MarketHub,
  MarketHubComparison,
  MarketHubId,
  MarketHubQuote,
  MarketQuoteRequest,
  MarketTypeSearchMatch
} from './market'
export type {
  RouteIntelRequest,
  RouteIntelResult,
  RouteMode,
  RouteSystemIntel,
  RouteWaypointRequest,
  RouteWaypointResult
} from './route-intel'
export type {
  PersonalEconomyScope,
  PersonalEconomySnapshot
} from './personal-economy'
export type {
  NativeAlertKind,
  NativeAlertRequest,
  NativeAlertResult,
  NativeAlertWorkspace,
  TrayStatus
} from './native-alert'
export type {
  UiDensity,
  UiSettings,
  UiSettingsApi,
  UiSettingsPatch,
  UiSettingsSnapshot,
  UiSettingsUpdateRequest
} from './ui-settings'
export type {
  EncounterJournalPage,
  EncounterPilotSearchPage,
  EncounterPilotSearchQuery,
  EncounterRecentQuery,
  EncounterSnapshot,
  EncounterSnapshotInput
} from './encounter-journal'
export type {
  WormholeChain,
  WormholeConnection,
  WormholeConnectionUpsertInput,
  WormholeProbeScanRecordRequest,
  WormholeHomeRoute,
  WormholeSystemNode,
  WormholeSystemUpsertInput
} from './wormhole-chain'
export type {
  DoctrineMatchResult,
  DoctrineTemplate,
  DoctrineTemplateInput
} from './doctrine-matcher'
export type { HunterPlan, HunterPlanRequest } from './hunter-planner'
export type {
  MarketOpportunityEvaluationRequest,
  MarketOpportunityRadar
} from './market-opportunity'

export type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'unknown'

export interface PilotStats {
  dangerRatio: number | null
  gangRatio: number | null
  soloRatio: number | null
  shipsDestroyed: number
  shipsLost: number
  soloKills: number
  iskDestroyed: number
  activeMonths: number
  lastActivity: string | null
  targetProfile: TargetProfile
}

export interface PilotIntel {
  id: number
  name: string
  corporationId: number | null
  corporationName: string | null
  allianceId: number | null
  allianceName: string | null
  factionId: number | null
  stats: PilotStats | null
  threatScore: number
  threatLevel: ThreatLevel
  reasons: string[]
  zkillUrl: string
  cached: boolean
  error: string | null
  /** Present after main-process SSO enrichment; absent without an authorized context. */
  relationship?: PilotClassification
}

export interface PilotIntelRequest {
  characterId: number
  forceRefresh?: boolean
}

export interface CorporationGroup {
  id: number | null
  name: string
  count: number
}

export interface ScanSummary {
  total: number
  resolved: number
  dangerous: number
  unknown: number
  cached: number
  durationMs: number
  corporationGroups: CorporationGroup[]
}

export interface ScanResult {
  scannedAt: string
  pilots: PilotIntel[]
  unresolvedNames: string[]
  warnings: string[]
  summary: ScanSummary
}

export interface ScanRequest {
  rawText: string
  forceRefresh?: boolean
}

export interface ScanProgress {
  completed: number
  total: number
  currentName: string | null
  /** A fully assembled pilot row that can be rendered before the batch completes. */
  readyPilot?: PilotIntel
}

export interface AppStatus {
  version: string
  cacheEntries: number
  databasePath: string
}

export interface LocalPreview {
  names: string[]
  rejected: number
}

/** Public account state safe to expose through Electron IPC. Tokens never belong here. */
export interface EveAccountStatus {
  configured: boolean
  connected: boolean
  clientId: string | null
  callbackUri: string
  characterId: number | null
  characterName: string | null
  scopes: string[]
  error: string | null
  /** macOS ad-hoc builds intentionally forget SSO when the application closes. */
  sessionOnly?: boolean
}

export interface CurrentSystemSnapshot {
  account: EveAccountStatus
  online: boolean | null
  /**
   * Authenticated location, kept separate from public System Intel so a
   * temporary zKill/metadata failure cannot hide a real ESI system change.
   */
  location: {
    solarSystemId: number
  } | null
  ownShip: {
    typeId: number
    typeName: string | null
    customName: string | null
  } | null
  intel: SystemIntel | null
  fetchedAt: string
  warnings: string[]
}

export type CombatHistoryKind = 'kill' | 'loss'

export interface CombatHistoryAttacker {
  characterId: number
  name: string | null
  corporationId: number | null
  corporationName: string | null
  allianceId: number | null
  allianceName: string | null
  shipTypeId: number | null
  shipName: string | null
  weaponTypeId: number | null
  weaponName: string | null
  damageDone: number
  finalBlow: boolean
}

export interface CombatHistoryEntry {
  kind: CombatHistoryKind
  killmailId: number
  time: string
  solarSystemId: number
  solarSystemName: string | null
  victimCharacterId: number | null
  victimName: string | null
  victimCorporationName: string | null
  victimFit: ShipFit
  /** Official inventory group for the victim hull when ESI metadata was available. */
  victimShipGroupId?: number | null
  attackerShipTypeId: number | null
  attackerShipName: string | null
  pilotFinalBlow: boolean
  /** Capsuleer attackers shown in the expanded killmail card. */
  attackers: CombatHistoryAttacker[]
  /** Full capsuleer count before the renderer safety cap. */
  attackerCount: number
  attackersCapped: boolean
  /** NPCs, structures, and other attackers without a character ID. */
  nonCapsuleerAttackerCount: number
  totalValue: number | null
  solo: boolean
}

export interface CombatHistoryRequest {
  characterId: number
  /** Omit for the initial sample of both tabs; set when loading one tab further. */
  kind?: CombatHistoryKind
  /** Zero-based position in the selected kind's deduplicated public history. */
  offset?: number
  limit?: number
  forceRefresh?: boolean
}

export interface CombatHistoryPageInfo {
  offset: number
  limit: number
  nextOffset: number
  hasMore: boolean
  /** The local safety ceiling was reached; older rows may still exist upstream. */
  capped?: boolean
}

/** Lightweight kills-only evidence used by the contextual target-risk table. */
export interface RecentTargetProfileRequest {
  characterId: number
  /** Number of latest public kills to inspect. Capped at ten. */
  limit?: number
  forceRefresh?: boolean
}

export interface RecentTargetProfileSnapshot {
  characterId: number
  fetchedAt: string
  cached: boolean
  /** Number of zKill rows selected before public-killmail hydration. */
  requestedSampleSize: number
  /** Number of rows with a valid victim type ID, including role-unknown `other`. */
  sampleSize: number
  /** False when a selected killmail or its official type metadata could not be read. */
  complete: boolean
  profile: TargetProfile
  warnings: string[]
}

export interface PilotCombatHistory {
  characterId: number
  fetchedAt: string
  cached: boolean
  kills: CombatHistoryEntry[]
  losses: CombatHistoryEntry[]
  /** Only the kinds requested in this response are present. */
  pageInfo: Partial<Record<CombatHistoryKind, CombatHistoryPageInfo>>
  warnings: string[]
}

export interface EveLocalIntelApi {
  analyzeLocal(request: ScanRequest): Promise<ScanResult>
  getPilotIntel(request: PilotIntelRequest): Promise<PilotIntel>
  resolveDscanTypeNames(request: DscanTypeNameRequest): Promise<DscanTypeName[]>
  getCombatHistory(request: CombatHistoryRequest): Promise<PilotCombatHistory>
  getRecentTargetProfile(request: RecentTargetProfileRequest): Promise<RecentTargetProfileSnapshot>
  getPilotWatchlist(): Promise<PilotWatchlistSnapshot>
  upsertPilotWatchlist(request: PilotWatchlistUpsertRequest): Promise<PilotWatchlistSnapshot>
  removePilotWatchlist(request: PilotWatchlistRemoveRequest): Promise<PilotWatchlistSnapshot>
  importEveWatchlistContacts(): Promise<PilotWatchlistSnapshot>
  getAccountStatus(): Promise<EveAccountStatus>
  restoreAccount(): Promise<EveAccountStatus>
  connectAccount(): Promise<EveAccountStatus>
  cancelAccountConnect(): Promise<void>
  disconnectAccount(): Promise<EveAccountStatus>
  getCharactersStatus(): Promise<EveMultiAccountStatus>
  connectCharacter(): Promise<EveMultiAccountStatus>
  selectCharacter(characterId: number): Promise<EveMultiAccountStatus>
  disconnectCharacter(characterId: number): Promise<EveMultiAccountStatus>
  removeCharacter(characterId: number): Promise<EveMultiAccountStatus>
  getCurrentSystem(): Promise<CurrentSystemSnapshot>
  recordProbeScan(request: ProbeScanRecordRequest): Promise<ProbeSystemObservation>
  getNearbyAnomalies(request: NearbyAnomalyRequest): Promise<NearbyAnomalySnapshot>
  getNearbyPve(request: NearbyPveRequest): Promise<NearbyPveSnapshot>
  getPilotContext(request?: PilotContextQuery): Promise<PilotContext | null>
  pollKillAlerts(request: KillAlertPollRequest): Promise<KillAlertPollResponse>
  searchInventoryTypes(
    query: string,
    limit?: number,
    forceRefresh?: boolean
  ): Promise<MarketTypeSearchMatch[]>
  compareMarketHubs(request: MarketComparisonRequest): Promise<MarketHubComparison>
  evaluateMarketOpportunity(
    request: MarketOpportunityEvaluationRequest
  ): Promise<MarketOpportunityRadar>
  appraiseMarketText(request: MarketAppraisalRequest): Promise<MarketAppraisal>
  getRouteIntel(request: RouteIntelRequest): Promise<RouteIntelResult>
  setRouteWaypoints(request: RouteWaypointRequest): Promise<RouteWaypointResult>
  getPersonalEconomy(request?: { forceRefresh?: boolean }): Promise<PersonalEconomySnapshot>
  getIndustryCharacter(request?: { forceRefresh?: boolean }): Promise<IndustryCharacterSnapshot>
  getIndustryLedger(request?: { forceRefresh?: boolean }): Promise<IndustryLedgerSnapshot>
  getIndustryMonitor(): Promise<IndustryMonitorSnapshot>
  configureIndustryMonitor(request: IndustryMonitorConfig): Promise<IndustryMonitorSnapshot>
  getIndustryProduction(request?: { forceRefresh?: boolean }): Promise<IndustryProductionSnapshot>
  saveIndustryProduction(request: IndustryProductionCost): Promise<IndustryProductionSnapshot>
  connectIndustryCharacter(): Promise<EveMultiAccountStatus>
  scanIndustry(request: IndustryScanRequest): Promise<IndustryScanResult>
  getIndustryFactories(request: IndustryFactoryRequest): Promise<IndustryFactoryResult>
  getIndustryLiquidity(request: IndustryLiquidityRequest): Promise<IndustryLiquidity[]>
  cancelIndustryScan(): Promise<void>
  onIndustryProgress(callback: (progress: IndustryScanProgress) => void): () => void
  recordEncounter(request: EncounterSnapshotInput): Promise<EncounterSnapshot>
  getEncounterJournal(query?: EncounterRecentQuery): Promise<EncounterJournalPage>
  searchEncounterPilot(query: EncounterPilotSearchQuery): Promise<EncounterPilotSearchPage>
  getEncounterCount(): Promise<number>
  getHunterPlan(request: HunterPlanRequest): Promise<HunterPlan>
  getWormholeChain(): Promise<WormholeChain>
  upsertWormholeSystem(input: WormholeSystemUpsertInput): Promise<WormholeSystemNode>
  setWormholeHome(systemNodeId: string): Promise<WormholeSystemNode>
  upsertWormholeConnection(input: WormholeConnectionUpsertInput): Promise<WormholeConnection>
  updateWormholeConnectionStatus(
    connectionId: string,
    statusText: string
  ): Promise<WormholeConnection>
  recordWormholeProbeScan(request: WormholeProbeScanRecordRequest): Promise<WormholeChain>
  listDoctrineTemplates(): Promise<DoctrineTemplate[]>
  saveDoctrineTemplate(input: DoctrineTemplateInput): Promise<DoctrineTemplate>
  deleteDoctrineTemplate(id: string): Promise<boolean>
  matchDoctrine(templateId: string, rawDscanText: string): Promise<DoctrineMatchResult>
  listSharedWorkspaces(): Promise<SharedWorkspaceSummary[]>
  getSharedWorkspace(workspaceId: string): Promise<SharedWorkspaceSnapshot>
  createSharedWorkspace(name: string): Promise<SharedWorkspaceSnapshot>
  acceptSharedWorkspaceConsent(
    workspaceId: string,
    policyVersion: number,
    scopes: SharedWorkspaceShareScope[],
    expectedWorkspaceRevision: number
  ): Promise<SharedWorkspaceSnapshot>
  revokeSharedWorkspaceConsent(
    workspaceId: string,
    expectedWorkspaceRevision: number
  ): Promise<SharedWorkspaceSnapshot>
  addSharedWorkspaceMember(
    workspaceId: string,
    characterId: number,
    characterName: string,
    role: Exclude<SharedWorkspaceRole, 'owner'>,
    expectedWorkspaceRevision: number
  ): Promise<SharedWorkspaceSnapshot>
  applySharedWorkspaceMutation(
    workspaceId: string,
    mutation: SharedWorkspaceMutation
  ): Promise<SharedWorkspaceMutationResult>
  getUiSettings(): Promise<UiSettingsSnapshot>
  updateUiSettings(request: UiSettingsUpdateRequest): Promise<UiSettingsSnapshot>
  setUiScale(scalePercent: number): void
  getTrayStatus(): Promise<TrayStatus>
  showNativeAlert(request: NativeAlertRequest): Promise<NativeAlertResult>
  onWorkspaceNavigation(callback: (workspace: NativeAlertWorkspace) => void): () => void
  previewLocal(rawText: string): Promise<LocalPreview>
  readClipboard(): Promise<string>
  getStatus(): Promise<AppStatus>
  clearCache(): Promise<void>
  onScanProgress(callback: (progress: ScanProgress) => void): () => void
}
