import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { validateUiSettingsPatch } from '../shared/ui-settings'
import type { IndustryScanProgress } from '../shared/industry'
import type {
  AppStatus,
  CombatHistoryRequest,
  CurrentSystemSnapshot,
  DscanTypeName,
  DscanTypeNameRequest,
  EveAccountStatus,
  EveMultiAccountStatus,
  EveLocalIntelApi,
  KillAlertPollRequest,
  KillAlertPollResponse,
  LocalPreview,
  MarketAppraisal,
  MarketAppraisalRequest,
  MarketComparisonRequest,
  MarketHubComparison,
  MarketTypeSearchMatch,
  PersonalEconomySnapshot,
  PilotContext,
  PilotContextQuery,
  PilotCombatHistory,
  PilotIntel,
  PilotIntelRequest,
  RecentTargetProfileRequest,
  RecentTargetProfileSnapshot,
  PilotWatchlistRemoveRequest,
  PilotWatchlistSnapshot,
  PilotWatchlistUpsertRequest,
  RouteIntelRequest,
  RouteIntelResult,
  RouteWaypointRequest,
  RouteWaypointResult,
  EncounterJournalPage,
  EncounterPilotSearchPage,
  EncounterPilotSearchQuery,
  EncounterRecentQuery,
  EncounterSnapshot,
  EncounterSnapshotInput,
  NativeAlertRequest,
  NativeAlertResult,
  NativeAlertWorkspace,
  NearbyAnomalyRequest,
  NearbyAnomalySnapshot,
  NearbyPveRequest,
  NearbyPveSnapshot,
  ProbeScanRecordRequest,
  ProbeSystemObservation,
  ScanProgress,
  ScanRequest,
  ScanResult,
  SharedWorkspaceMutation,
  SharedWorkspaceMutationResult,
  SharedWorkspaceRole,
  SharedWorkspaceShareScope,
  SharedWorkspaceSnapshot,
  SharedWorkspaceSummary,
  TrayStatus,
  UiSettingsSnapshot,
  UiSettingsUpdateRequest
} from '../shared/types'

const api: EveLocalIntelApi = {
  getIndustryCharacter: (request = {}) => ipcRenderer.invoke('industry:character', request),
  getIndustryLedger: (request = {}) => ipcRenderer.invoke('industry:ledger', request),
  getIndustryMonitor: () => ipcRenderer.invoke('industry:monitor:get'),
  configureIndustryMonitor: request => ipcRenderer.invoke('industry:monitor:set', request),
  getIndustryProduction: (request = {}) => ipcRenderer.invoke('industry:production:get', request),
  saveIndustryProduction: request => ipcRenderer.invoke('industry:production:save', request),
  connectIndustryCharacter: () => ipcRenderer.invoke('industry:connect'),
  scanIndustry: request => ipcRenderer.invoke('industry:scan', request),
  getIndustryFactories: request => ipcRenderer.invoke('industry:factories', request),
  getIndustryLiquidity: request => ipcRenderer.invoke('industry:liquidity', request),
  cancelIndustryScan: () => ipcRenderer.invoke('industry:cancel'),
  onIndustryProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: IndustryScanProgress): void => callback(progress)
    ipcRenderer.on('industry:progress', listener)
    return () => ipcRenderer.removeListener('industry:progress', listener)
  },
  analyzeLocal: (request: ScanRequest): Promise<ScanResult> =>
    ipcRenderer.invoke('intel:analyze', request),
  getPilotIntel: (request: PilotIntelRequest): Promise<PilotIntel> =>
    ipcRenderer.invoke('intel:pilot', request),
  resolveDscanTypeNames: (request: DscanTypeNameRequest): Promise<DscanTypeName[]> =>
    ipcRenderer.invoke('dscan:resolve-type-names', request),
  getCombatHistory: (request: CombatHistoryRequest): Promise<PilotCombatHistory> =>
    ipcRenderer.invoke('intel:combat-history', request),
  getRecentTargetProfile: (
    request: RecentTargetProfileRequest
  ): Promise<RecentTargetProfileSnapshot> =>
    ipcRenderer.invoke('intel:recent-target-profile', request),
  getPilotWatchlist: (): Promise<PilotWatchlistSnapshot> =>
    ipcRenderer.invoke('pilot-watchlist:list'),
  upsertPilotWatchlist: (
    request: PilotWatchlistUpsertRequest
  ): Promise<PilotWatchlistSnapshot> =>
    ipcRenderer.invoke('pilot-watchlist:upsert', request),
  removePilotWatchlist: (
    request: PilotWatchlistRemoveRequest
  ): Promise<PilotWatchlistSnapshot> =>
    ipcRenderer.invoke('pilot-watchlist:remove', request),
  importEveWatchlistContacts: (): Promise<PilotWatchlistSnapshot> =>
    ipcRenderer.invoke('pilot-watchlist:import-eve-contacts'),
  getAccountStatus: (): Promise<EveAccountStatus> =>
    ipcRenderer.invoke('account:status'),
  restoreAccount: (): Promise<EveAccountStatus> =>
    ipcRenderer.invoke('account:restore'),
  connectAccount: (): Promise<EveAccountStatus> =>
    ipcRenderer.invoke('account:connect'),
  cancelAccountConnect: (): Promise<void> =>
    ipcRenderer.invoke('account:connect:cancel'),
  disconnectAccount: (): Promise<EveAccountStatus> =>
    ipcRenderer.invoke('account:disconnect'),
  getCharactersStatus: (): Promise<EveMultiAccountStatus> =>
    ipcRenderer.invoke('account:characters:status'),
  connectCharacter: (): Promise<EveMultiAccountStatus> =>
    ipcRenderer.invoke('account:characters:connect'),
  selectCharacter: (characterId: number): Promise<EveMultiAccountStatus> =>
    ipcRenderer.invoke('account:characters:select', { characterId }),
  disconnectCharacter: (characterId: number): Promise<EveMultiAccountStatus> =>
    ipcRenderer.invoke('account:characters:disconnect', { characterId }),
  removeCharacter: (characterId: number): Promise<EveMultiAccountStatus> =>
    ipcRenderer.invoke('account:characters:remove', { characterId }),
  getCurrentSystem: (): Promise<CurrentSystemSnapshot> =>
    ipcRenderer.invoke('system:current'),
  recordProbeScan: (request: ProbeScanRecordRequest): Promise<ProbeSystemObservation> =>
    ipcRenderer.invoke('anomaly:record-probe', request),
  getNearbyAnomalies: (request: NearbyAnomalyRequest): Promise<NearbyAnomalySnapshot> =>
    ipcRenderer.invoke('anomaly:nearby', request),
  getNearbyPve: (request: NearbyPveRequest): Promise<NearbyPveSnapshot> =>
    ipcRenderer.invoke('pve:nearby', request),
  getPilotContext: (request?: PilotContextQuery): Promise<PilotContext | null> =>
    ipcRenderer.invoke('pilot:context', request),
  pollKillAlerts: (request: KillAlertPollRequest): Promise<KillAlertPollResponse> =>
    ipcRenderer.invoke('kill-alerts:poll', request),
  searchInventoryTypes: (
    query: string,
    limit?: number,
    forceRefresh?: boolean
  ): Promise<MarketTypeSearchMatch[]> =>
    ipcRenderer.invoke('market:search', { query, limit, forceRefresh }),
  compareMarketHubs: (request: MarketComparisonRequest): Promise<MarketHubComparison> =>
    ipcRenderer.invoke('market:compare', request),
  evaluateMarketOpportunity: (request) => ipcRenderer.invoke('pro:market:evaluate', request),
  appraiseMarketText: (request: MarketAppraisalRequest): Promise<MarketAppraisal> =>
    ipcRenderer.invoke('market:appraise', request),
  getRouteIntel: (request: RouteIntelRequest): Promise<RouteIntelResult> =>
    ipcRenderer.invoke('route:analyze', request),
  setRouteWaypoints: (request: RouteWaypointRequest): Promise<RouteWaypointResult> =>
    ipcRenderer.invoke('route:set-waypoints', request),
  getPersonalEconomy: (
    request?: { forceRefresh?: boolean }
  ): Promise<PersonalEconomySnapshot> =>
    ipcRenderer.invoke('economy:snapshot', request),
  recordEncounter: (request: EncounterSnapshotInput): Promise<EncounterSnapshot> =>
    ipcRenderer.invoke('encounter:record', request),
  getEncounterJournal: (query?: EncounterRecentQuery): Promise<EncounterJournalPage> =>
    ipcRenderer.invoke('encounter:list', query),
  searchEncounterPilot: (
    query: EncounterPilotSearchQuery
  ): Promise<EncounterPilotSearchPage> =>
    ipcRenderer.invoke('encounter:search-pilot', query),
  getEncounterCount: (): Promise<number> => ipcRenderer.invoke('encounter:count'),
  getHunterPlan: (request) => ipcRenderer.invoke('pro:hunter:plan', request),
  getWormholeChain: () => ipcRenderer.invoke('pro:wormhole:get'),
  upsertWormholeSystem: (input) => ipcRenderer.invoke('pro:wormhole:upsert-system', input),
  setWormholeHome: (systemNodeId) =>
    ipcRenderer.invoke('pro:wormhole:set-home', { systemNodeId }),
  upsertWormholeConnection: (input) =>
    ipcRenderer.invoke('pro:wormhole:upsert-connection', input),
  updateWormholeConnectionStatus: (connectionId, statusText) =>
    ipcRenderer.invoke('pro:wormhole:update-status', { connectionId, statusText }),
  recordWormholeProbeScan: (request) => ipcRenderer.invoke('pro:wormhole:record-probe', request),
  listDoctrineTemplates: () => ipcRenderer.invoke('pro:doctrine:list'),
  saveDoctrineTemplate: (input) => ipcRenderer.invoke('pro:doctrine:save', input),
  deleteDoctrineTemplate: (id) => ipcRenderer.invoke('pro:doctrine:delete', { id }),
  matchDoctrine: (templateId, rawDscanText) =>
    ipcRenderer.invoke('pro:doctrine:match', { templateId, rawDscanText }),
  listSharedWorkspaces: (): Promise<SharedWorkspaceSummary[]> =>
    ipcRenderer.invoke('pro:fleet:list'),
  getSharedWorkspace: (workspaceId: string): Promise<SharedWorkspaceSnapshot> =>
    ipcRenderer.invoke('pro:fleet:get', { workspaceId }),
  createSharedWorkspace: (name: string): Promise<SharedWorkspaceSnapshot> =>
    ipcRenderer.invoke('pro:fleet:create', { name }),
  acceptSharedWorkspaceConsent: (
    workspaceId: string,
    policyVersion: number,
    scopes: SharedWorkspaceShareScope[],
    expectedWorkspaceRevision: number
  ): Promise<SharedWorkspaceSnapshot> => ipcRenderer.invoke('pro:fleet:consent:accept', {
    workspaceId,
    policyVersion,
    scopes,
    expectedWorkspaceRevision
  }),
  revokeSharedWorkspaceConsent: (
    workspaceId: string,
    expectedWorkspaceRevision: number
  ): Promise<SharedWorkspaceSnapshot> => ipcRenderer.invoke('pro:fleet:consent:revoke', {
    workspaceId,
    expectedWorkspaceRevision
  }),
  addSharedWorkspaceMember: (
    workspaceId: string,
    characterId: number,
    characterName: string,
    role: Exclude<SharedWorkspaceRole, 'owner'>,
    expectedWorkspaceRevision: number
  ): Promise<SharedWorkspaceSnapshot> => ipcRenderer.invoke('pro:fleet:member:add', {
    workspaceId,
    characterId,
    characterName,
    role,
    expectedWorkspaceRevision
  }),
  applySharedWorkspaceMutation: (
    workspaceId: string,
    mutation: SharedWorkspaceMutation
  ): Promise<SharedWorkspaceMutationResult> => ipcRenderer.invoke('pro:fleet:mutation:apply', {
    workspaceId,
    mutation
  }),
  getUiSettings: (): Promise<UiSettingsSnapshot> => ipcRenderer.invoke('settings:get'),
  updateUiSettings: (request: UiSettingsUpdateRequest): Promise<UiSettingsSnapshot> =>
    ipcRenderer.invoke('settings:update', request),
  setUiScale: (scalePercent: number): void => {
    const validated = validateUiSettingsPatch({ scalePercent })
    webFrame.setZoomFactor(validated.scalePercent! / 100)
  },
  getTrayStatus: (): Promise<TrayStatus> => ipcRenderer.invoke('app:tray-status'),
  showNativeAlert: (request: NativeAlertRequest): Promise<NativeAlertResult> =>
    ipcRenderer.invoke('notification:show', request),
  onWorkspaceNavigation: (
    callback: (workspace: NativeAlertWorkspace) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, workspace: unknown): void => {
      if (workspace === 'intel' || workspace === 'route' || workspace === 'watchlist') {
        callback(workspace)
      }
    }
    ipcRenderer.on('app:navigate', listener)
    return () => ipcRenderer.removeListener('app:navigate', listener)
  },
  previewLocal: (rawText: string): Promise<LocalPreview> =>
    ipcRenderer.invoke('intel:preview', rawText),
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
  getStatus: (): Promise<AppStatus> => ipcRenderer.invoke('app:status'),
  clearCache: (): Promise<void> => ipcRenderer.invoke('cache:clear'),
  onScanProgress: (callback: (progress: ScanProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ScanProgress): void => {
      callback(progress)
    }

    ipcRenderer.on('intel:progress', listener)
    return () => ipcRenderer.removeListener('intel:progress', listener)
  }
}

contextBridge.exposeInMainWorld('eveIntel', api)
