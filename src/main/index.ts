import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  session,
  shell
} from 'electron'
import { parseLocalRoster } from '../shared/local-parser'
import { parseDscanRows, parseProbeClipboard, parseProbeRows } from '../shared/clipboard-intel'
import { matchDscanDoctrine } from '../shared/doctrine-matcher'
import { FLY_SAFE_EVE_CLIENT_ID } from '../shared/eve-application'
import { PRO_FEATURES, type ProFeatureId } from '../shared/pro-features'
import {
  validateCharacterSelectionRequest,
  type EveMultiAccountStatus
} from '../shared/multi-account'
import type {
  CombatHistoryRequest,
  CorporationGroup,
  EveAccountStatus,
  HunterPlanRequest,
  MarketAppraisalRequest,
  MarketComparisonRequest,
  MarketOpportunityEvaluationRequest,
  PilotContextQuery,
  PilotIntel,
  PilotIntelRequest,
  RecentTargetProfileRequest,
  PilotWatchlistUpsertRequest,
  RouteIntelRequest,
  ScanRequest,
  ScanResult,
  WormholeConnectionUpsertInput,
  WormholeProbeScanRecordRequest,
  WormholeSystemUpsertInput
} from '../shared/types'
import {
  summarizeProbeScan,
  validateNearbyAnomalyRequest,
  validateProbeScanRecordRequest
} from '../shared/nearby-anomalies'
import { validateNearbyPveRequest } from '../shared/nearby-pve'
import { buildHunterPlan } from '../shared/hunter-planner'
import { EveMultiAccountService } from './multi-account-service'
import { Cache } from './cache'
import { CurrentSystemService } from './current-system-service'
import {
  parseDscanTypeNameRequest,
  toPublicDscanTypeNames
} from './dscan-type-ipc'
import { EsiClient } from './esi-client'
import { ESI_UI_SCOPES } from './esi-client'
import { EveSsoClient } from './eve-sso'
import { EncounterJournalStore } from './encounter-store'
import { IntelService } from './intel-service'
import {
  collectKillAlertTypeIds,
  enrichKillAlertShipNames
} from './kill-alert-enrichment'
import {
  parseKillAlertPollRequest,
  toPublicKillAlertPollResponse
} from './kill-alert-ipc'
import { KillAlertService } from './kill-alert-service'
import { MarketService } from './market-service'
import { MarketOpportunityService } from './market-opportunity-service'
import { parseNativeAlertRequest } from './native-alert-ipc'
import { NativeAlertService } from './native-alert-service'
import { PersonalEconomyService } from './personal-economy-service'
import { IndustryService, INDUSTRY_CATALOG } from './industry-service'
import { IndustryMonitorService } from './industry-monitor-service'
import { IndustryProductionService } from './industry-production-service'
import type { IndustryScanRequest, IndustryFactoryRequest } from '../shared/industry'
import { enrichScanWithPilotContext } from './pilot-context-merge'
import { PilotContextService } from './pilot-context-service'
import {
  parsePilotWatchlistRemoveRequest,
  parsePilotWatchlistUpsertRequest
} from './pilot-watchlist-ipc'
import { PilotWatchlistStore } from './pilot-watchlist-store'
import {
  PILOT_WATCHLIST_ALERT_SOURCES,
  getPilotWatchlistEntityId,
  getPilotWatchlistEntityType
} from '../shared/pilot-watchlist'
import {
  API_NETWORK_USER_AGENT,
  configureSystemProxySession,
  createProxyAwareFetch
} from './proxy-fetch'
import { R2z2Client } from './r2z2-client'
import {
  createZkillRelayFetch,
  R2Z2_RELAY_PATH,
  ZKILL_RELAY_PATH
} from './zkill-relay-fetch'
import { RouteIntelService } from './route-intel-service'
import { ZkillRouteSystemIntelLookup } from './route-intel-service'
import {
  createRendererTrustPolicy,
  isTrustedIpcSender,
  isTrustedRendererUrl
} from './renderer-security'
import { SystemIntelService } from './system-intel-service'
import { TrayController } from './tray-controller'
import type { NativeAlertWorkspace } from '../shared/native-alert'
import { validateRouteWaypointRequest } from '../shared/route-intel'
import { UiSettingsStore } from './ui-settings-store'
import { DoctrineTemplateStore } from './doctrine-store'
import { WormholeChainStore } from './wormhole-chain-store'
import { SharedWorkspaceService } from './shared-workspace-service'
import { NearbyAnomalyService } from './nearby-anomaly-service'
import { NearbyPveService } from './nearby-pve-service'
import { ProbeScanStore } from './probe-scan-store'
import { resolveSubscriptionBackendUrl } from './subscription-backend-config'
import { resolveCombatRelayUrl } from './combat-relay-config'
import {
  parseAcceptSharedWorkspaceConsentRequest,
  parseAddSharedWorkspaceMemberRequest,
  parseApplySharedWorkspaceMutationRequest,
  parseCreateSharedWorkspaceRequest,
  parseGetSharedWorkspaceRequest,
  parseRevokeSharedWorkspaceConsentRequest,
  toPublicSharedWorkspaceMutationResult,
  toPublicSharedWorkspaceSnapshot,
  toPublicSharedWorkspaceSummary
} from './shared-workspace-ipc'
import {
  parseUiSettingsGetRequest,
  parseUiSettingsUpdateRequest
} from './ui-settings-ipc'

const configuredRendererUrl = process.env.ELECTRON_RENDERER_URL
const bundledRendererPath = join(__dirname, '../renderer/index.html')
const SAFE_STORAGE_STARTUP_DELAY_MS = process.platform === 'darwin' ? 2_000 : 0
const COMBAT_API_REQUEST_BUDGET_MS = 8_000
const rendererTrustPolicy = createRendererTrustPolicy(
  configuredRendererUrl,
  bundledRendererPath
)
const isDevelopment = rendererTrustPolicy.mode === 'development'
let mainWindow: BrowserWindow | null = null
let intelService: IntelService | null = null
let accountService: EveMultiAccountService | null = null
let systemCache: Cache | null = null
let systemIntelService: SystemIntelService | null = null
let currentSystemService: CurrentSystemService | null = null
let pilotContextService: PilotContextService | null = null
let pilotWatchlistStore: PilotWatchlistStore | null = null
let killAlertService: KillAlertService | null = null
let esiClient: EsiClient | null = null
let marketService: MarketService | null = null
let marketOpportunityService: MarketOpportunityService | null = null
let routeIntelService: RouteIntelService | null = null
let personalEconomyService: PersonalEconomyService | null = null
let industryService: IndustryService | null = null
let industryMonitor: IndustryMonitorService | null = null
let industryProduction: IndustryProductionService | null = null
const industryScans = new Map<number, AbortController>()
let encounterJournalStore: EncounterJournalStore | null = null
let wormholeChainStore: WormholeChainStore | null = null
let probeScanStore: ProbeScanStore | null = null
let nearbyAnomalyService: NearbyAnomalyService | null = null
let nearbyPveService: NearbyPveService | null = null
let doctrineTemplateStore: DoctrineTemplateStore | null = null
let sharedWorkspaceService: SharedWorkspaceService | null = null
let subscriptionBackendBaseUrl: string | null = null
let combatRelayBaseUrl: string | null = null
let nativeAlertService: NativeAlertService | null = null
let trayController: TrayController | null = null
let uiSettingsStore: UiSettingsStore | null = null
let isQuitting = false
let servicesShutdown = false
let servicesInitialization: Promise<void> | null = null
let accountServicesInitialization: Promise<void> | null = null
let apiFetch: typeof fetch | null = null
let accountInitialization: Promise<void> = Promise.resolve()
let accountInitializationComplete = false
let currentAccountStatus: EveAccountStatus | null = null
let currentMultiAccountStatus: EveMultiAccountStatus | null = null

function createApplicationMenu(): void {
  const platformMenu: Electron.MenuItemConstructorOptions = process.platform === 'darwin'
    ? {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      }
    : {
        label: 'File',
        submenu: [
          { role: 'quit', label: 'Quit' }
        ]
      }

  const template: Electron.MenuItemConstructorOptions[] = [
    platformMenu,
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen', label: 'Toggle Full Screen' },
        ...(isDevelopment
          ? [
              { type: 'separator' as const },
              { role: 'reload' as const },
              { role: 'toggleDevTools' as const }
            ]
          : [])
      ]
    },
    {
      label: 'Window',
      submenu: process.platform === 'darwin'
        ? [
            { role: 'minimize', label: 'Minimize' },
            { role: 'front', label: 'Bring All to Front' }
          ]
        : [
            { role: 'minimize', label: 'Minimize' },
            { role: 'close', label: 'Close' }
          ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'Fly Safe',
    backgroundColor: '#080b12',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 18, y: 18 }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.on('close', (event) => {
    if (!isQuitting && backgroundModeEnabled()) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.platform === 'win32') {
    // Electron does not emit before-quit/will-quit during Windows shutdown,
    // restart or logout. Mark the close as terminal and flush local stores.
    mainWindow.on('query-session-end', beginShutdown)
    mainWindow.on('session-end', beginShutdown)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererTrustPolicy)) event.preventDefault()
  })

  if (rendererTrustPolicy.mode === 'development') {
    void mainWindow.loadURL(rendererTrustPolicy.entryUrl)
  } else {
    void mainWindow.loadFile(bundledRendererPath)
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('clipboard:read', (event) => {
    assertTrustedIpcEvent(event)
    return clipboard.readText()
  })

  ipcMain.handle('intel:preview', (event, rawText: unknown) => {
    assertTrustedIpcEvent(event)
    if (typeof rawText !== 'string') throw new TypeError('Expected Local text')
    return parseLocalRoster(rawText)
  })

  ipcMain.handle('dscan:resolve-type-names', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated = parseDscanTypeNameRequest(request)
    if (!esiClient) throw new Error('ESI service is not ready yet')

    try {
      const names = await esiClient.getUniverseNames(validated.typeIds)
      return toPublicDscanTypeNames(validated, names)
    } catch {
      // Fixed message prevents upstream bodies and cache metadata from crossing IPC.
      throw new Error('Could not resolve D-scan object types')
    }
  })

  ipcMain.handle('intel:analyze', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!intelService) throw new Error('Intel service is not ready yet')
    if (!request || typeof request !== 'object') throw new TypeError('Invalid intel request')

    const typedRequest = request as ScanRequest
    if (typeof typedRequest.rawText !== 'string') throw new TypeError('Expected Local text')
    if (typedRequest.rawText.length > 250_000) throw new Error('Local list is too large')

    const ownCharacterId = currentMultiAccountStatus?.activeCharacterId ?? null
    const result = await intelService.analyze(typedRequest, (progress) => {
      if (!isTrustedIpcEvent(event)) return
      const publicProgress = progress.readyPilot?.id === ownCharacterId
        ? {
            completed: progress.completed,
            total: progress.total,
            currentName: progress.currentName
          }
        : progress
      event.sender.send('intel:progress', publicProgress)
    })
    if (!accountInitializationComplete || !accountService) return result

    const authorized = await accountService.getAuthorizedSession()
    if (!authorized) return result

    const filtered = withoutPilot(result, authorized.session.characterId)
    if (!pilotContextService) return filtered

    try {
      const context = await pilotContextService.getContext({
        characterId: authorized.session.characterId,
        accessToken: authorized.accessToken,
        forceRefresh: typedRequest.forceRefresh,
        excludeOwnCharacter: true
      })
      return enrichScanWithPilotContext(filtered, context)
    } catch {
      // Access tokens and upstream error bodies must never cross IPC.
      return {
        ...filtered,
        warnings: [...filtered.warnings, 'Pilot Context: contact/fleet data unavailable']
      }
    }
  })

  ipcMain.handle('intel:combat-history', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!intelService) throw new Error('Intel service is not ready yet')
    if (!isRecord(request)) {
      throw new TypeError('Invalid battle-history request')
    }
    if (Object.keys(request).some((key) => (
      !['characterId', 'kind', 'offset', 'limit', 'forceRefresh'].includes(key)
    ))) {
      throw new TypeError('Battle-history request contains unknown fields')
    }

    const typedRequest = request as unknown as CombatHistoryRequest
    if (!Number.isSafeInteger(typedRequest.characterId) || typedRequest.characterId <= 0) {
      throw new TypeError('Invalid pilot ID')
    }
    if (
      typedRequest.kind !== undefined &&
      typedRequest.kind !== 'kill' &&
      typedRequest.kind !== 'loss'
    ) {
      throw new TypeError('Invalid battle-history type')
    }
    const maximumLimit = typedRequest.kind === undefined ? 10 : 50
    if (
      typedRequest.limit !== undefined &&
      (!Number.isSafeInteger(typedRequest.limit) ||
        typedRequest.limit < 1 ||
        typedRequest.limit > maximumLimit)
    ) {
      throw new RangeError(typedRequest.kind === undefined
        ? 'From 1 to 10 battles of each type are allowed'
        : 'You can load from 1 to 50 battles at a time')
    }
    if (
      typedRequest.offset !== undefined &&
      (!Number.isSafeInteger(typedRequest.offset) ||
        typedRequest.offset < 0 ||
        typedRequest.offset > 1_950)
    ) {
      throw new RangeError('Invalid battle-history offset')
    }
    if (
      typedRequest.kind === undefined &&
      typedRequest.offset !== undefined &&
      typedRequest.offset !== 0
    ) {
      throw new RangeError('Offset is allowed only when loading one battle type')
    }
    if (
      typedRequest.forceRefresh !== undefined &&
      typeof typedRequest.forceRefresh !== 'boolean'
    ) {
      throw new TypeError('Invalid battle-history refresh mode')
    }

    return intelService.getCombatHistory(typedRequest)
  })

  ipcMain.handle('intel:recent-target-profile', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!intelService) throw new Error('Intel service is not ready yet')
    if (!isRecord(request)) throw new TypeError('Invalid target-profile request')
    const keys = Object.keys(request)
    if (keys.some((key) => !['characterId', 'limit', 'forceRefresh'].includes(key))) {
      throw new TypeError('Target-profile request contains unknown fields')
    }

    const typedRequest = request as unknown as RecentTargetProfileRequest
    if (!Number.isSafeInteger(typedRequest.characterId) || typedRequest.characterId <= 0) {
      throw new TypeError('Invalid pilot ID')
    }
    if (
      typedRequest.limit !== undefined &&
      (!Number.isFinite(typedRequest.limit) || typedRequest.limit < 1 || typedRequest.limit > 10)
    ) {
      throw new RangeError('From 1 to 10 recent kills are allowed')
    }
    if (
      typedRequest.forceRefresh !== undefined &&
      typeof typedRequest.forceRefresh !== 'boolean'
    ) {
      throw new TypeError('Invalid target-profile refresh mode')
    }

    return intelService.getRecentTargetProfile(typedRequest)
  })

  ipcMain.handle('intel:pilot', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!intelService) throw new Error('Intel service is not ready yet')
    if (!isRecord(request)) throw new TypeError('Invalid pilot request')
    const keys = Object.keys(request)
    if (keys.some((key) => key !== 'characterId' && key !== 'forceRefresh')) {
      throw new TypeError('Pilot request contains unknown fields')
    }

    const typedRequest = request as unknown as PilotIntelRequest
    if (!Number.isSafeInteger(typedRequest.characterId) || typedRequest.characterId <= 0) {
      throw new TypeError('Invalid pilot ID')
    }
    if (
      typedRequest.forceRefresh !== undefined &&
      typeof typedRequest.forceRefresh !== 'boolean'
    ) {
      throw new TypeError('Invalid pilot refresh mode')
    }
    return intelService.getPilotIntel(typedRequest)
  })

  ipcMain.handle('pilot-watchlist:list', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    assertNoIpcArgument(request)
    return requirePilotWatchlistStore().list()
  })

  ipcMain.handle('pilot-watchlist:upsert', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated: PilotWatchlistUpsertRequest = parsePilotWatchlistUpsertRequest(request)
    return requirePilotWatchlistStore().upsert(validated)
  })

  ipcMain.handle('pilot-watchlist:remove', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated = parsePilotWatchlistRemoveRequest(request)
    return requirePilotWatchlistStore().removeEntity(
      validated.entityType ?? 'character',
      validated.entityId ?? validated.characterId
    )
  })

  ipcMain.handle('pilot-watchlist:import-eve-contacts', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    assertNoIpcArgument(request)
    if (!accountService || !pilotContextService) throw new Error('Pilot Context is not ready yet')
    await accountInitialization
    const authorized = await accountService.getAuthorizedSession()
    if (!authorized) throw new Error('Connect an EVE Online character')

    let context
    try {
      context = await pilotContextService.getContext({
        characterId: authorized.session.characterId,
        accessToken: authorized.accessToken,
        excludeOwnCharacter: true
      })
    } catch {
      throw new Error('Could not read EVE contacts')
    }
    if (!context.contacts) throw new Error('EVE contacts are currently unavailable')

    const store = requirePilotWatchlistStore()
    const existingEntities = new Set(store.list().entries.map((entry) => (
      `${getPilotWatchlistEntityType(entry)}:${getPilotWatchlistEntityId(entry)}`
    )))
    const importedContacts: PilotWatchlistUpsertRequest[] = []
    for (const contact of context.contacts.entries) {
      if (
        contact.type === 'faction' ||
        contact.name === null ||
        (contact.standing >= 0 && !contact.watched && !contact.blocked)
      ) continue
      const entityKey = `${contact.type}:${contact.id}`
      if (existingEntities.has(entityKey)) continue
      const tags = [...new Set(['EVE contact', ...contact.labelNames])]
        .map((tag) => tag.trim().slice(0, 32))
        .filter(Boolean)
        .slice(0, 20)
      const nonNegativeWatched = contact.standing >= 0 && contact.watched && !contact.blocked
      importedContacts.push({
        characterId: contact.id,
        entityType: contact.type,
        entityId: contact.id,
        name: contact.name,
        corporationName: null,
        severity: contact.blocked || contact.standing <= -5
          ? 'critical'
          : nonNegativeWatched
            ? 'watch'
            : 'danger',
        tags,
        alertSources: [...PILOT_WATCHLIST_ALERT_SOURCES],
        note: `EVE import · standing ${contact.standing}`,
        alertSoundEnabled: !nonNegativeWatched
      })
      existingEntities.add(entityKey)
    }
    return store.bulkUpsert(importedContacts)
  })

  ipcMain.handle('cache:clear', (event) => {
    assertTrustedIpcEvent(event)
    if (!intelService) throw new Error('Intel service is not ready yet')
    if (!systemIntelService) throw new Error('System service is not ready yet')
    intelService.clearCache()
    systemIntelService.clearCache()
  })

  ipcMain.handle('app:status', (event) => {
    assertTrustedIpcEvent(event)
    if (!intelService) throw new Error('Intel service is not ready yet')
    const stats = intelService.getCacheStats()
    return {
      version: app.getVersion(),
      cacheEntries: stats.entries + (systemCache?.count() ?? 0),
      databasePath: stats.databasePath
    }
  })

  ipcMain.handle('app:tray-status', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    assertNoIpcArgument(request)
    const status = trayController?.status() ?? { available: false, backgroundMode: false }
    return {
      available: status.available,
      backgroundMode: status.available && minimizeToTrayEnabled()
    }
  })

  ipcMain.handle('notification:show', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated = parseNativeAlertRequest(request)
    if (!nativeAlertService) throw new Error('Native alerts are not ready yet')
    if (
      validated.force !== true &&
      !requireUiSettingsStore().get().settings.backgroundNotificationsEnabled
    ) {
      return { shown: false, reason: 'disabled' } as const
    }
    return nativeAlertService.show(validated)
  })

  ipcMain.handle('settings:get', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    parseUiSettingsGetRequest(request)
    return requireUiSettingsStore().get()
  })

  ipcMain.handle('settings:update', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated = parseUiSettingsUpdateRequest(request)
    return requireUiSettingsStore().update(validated.patch)
  })

  ipcMain.handle('account:status', async (event, request: unknown) => {
    assertUnlicensedIpcEvent(event)
    assertNoIpcArgument(request)
    if (!accountService) throw new Error('Account service is not ready yet')
    await accountInitialization
    return refreshAccountSnapshots()
  })

  ipcMain.handle('account:restore', async (event, request: unknown) => {
    assertUnlicensedIpcEvent(event)
    assertNoIpcArgument(request)
    if (!accountService) throw new Error('Account service is not ready yet')
    await accountInitialization
    currentAccountStatus = await accountService.restore()
    currentMultiAccountStatus = await accountService.getAccountsStatus()
    return currentAccountStatus
  })

  ipcMain.handle('account:connect', async (event, request: unknown) => {
    assertUnlicensedIpcEvent(event)
    assertNoIpcArgument(request)
    if (!accountService) throw new Error('Account service is not ready yet')

    await accountInitialization
    currentAccountStatus = await accountService.connect()
    currentMultiAccountStatus = await accountService.getAccountsStatus()
    return currentAccountStatus
  })

  ipcMain.handle('account:connect:cancel', async (event, request: unknown) => {
    assertUnlicensedIpcEvent(event)
    assertNoIpcArgument(request)
    if (!accountService) throw new Error('Account service is not ready yet')
    await accountService.cancelConnect()
  })

  ipcMain.handle('account:disconnect', async (event, request: unknown) => {
    // Account disconnect remains available before and after sign-in failures.
    assertUnlicensedIpcEvent(event)
    assertNoIpcArgument(request)
    if (!accountService) throw new Error('Account service is not ready yet')
    await accountInitialization
    currentAccountStatus = await accountService.disconnect()
    currentMultiAccountStatus = await accountService.getAccountsStatus()
    return currentAccountStatus
  })

  ipcMain.handle('account:characters:status', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, PRO_FEATURES.characters)
    assertNoIpcArgument(request)
    await accountInitialization
    if (!accountService) throw new Error('Account service is not ready yet')
    currentMultiAccountStatus = await accountService.getAccountsStatus()
    return currentMultiAccountStatus
  })

  ipcMain.handle('account:characters:connect', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, PRO_FEATURES.characters)
    assertNoIpcArgument(request)
    await accountInitialization
    if (!accountService) throw new Error('Account service is not ready yet')
    currentMultiAccountStatus = await accountService.connectCharacter()
    currentAccountStatus = await accountService.getStatus()
    return currentMultiAccountStatus
  })

  ipcMain.handle('account:characters:select', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, PRO_FEATURES.characters)
    const { characterId } = validateCharacterSelectionRequest(request)
    await accountInitialization
    if (!accountService) throw new Error('Account service is not ready yet')
    const before = await accountService.getAccountsStatus()
    const target = before.characters.find((character) => character.characterId === characterId)
    if (!target || (!target.credentialStored && !target.connected)) {
      throw new Error('Reconnect this character through EVE SSO first')
    }
    try {
      await accountService.selectActiveCharacter(characterId)
      currentMultiAccountStatus = await accountService.restoreCharacter(characterId)
    } finally {
      currentAccountStatus = await accountService.getStatus()
      currentMultiAccountStatus = await accountService.getAccountsStatus()
    }
    if (!currentAccountStatus.connected) {
      throw new Error('Could not restore the selected character’s SSO session')
    }
    return currentMultiAccountStatus
  })

  ipcMain.handle('account:characters:disconnect', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, PRO_FEATURES.characters)
    const { characterId } = validateCharacterSelectionRequest(request)
    await accountInitialization
    if (!accountService) throw new Error('Account service is not ready yet')
    currentMultiAccountStatus = await accountService.disconnectCharacter(characterId)
    currentMultiAccountStatus = await restoreOwnerAfterActiveCharacterRemoval(characterId)
    currentAccountStatus = await accountService.getStatus()
    return currentMultiAccountStatus
  })

  ipcMain.handle('account:characters:remove', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, PRO_FEATURES.characters)
    const { characterId } = validateCharacterSelectionRequest(request)
    await accountInitialization
    if (!accountService) throw new Error('Account service is not ready yet')
    currentMultiAccountStatus = await accountService.removeCharacter(characterId)
    currentMultiAccountStatus = await restoreOwnerAfterActiveCharacterRemoval(characterId)
    currentAccountStatus = await accountService.getStatus()
    return currentMultiAccountStatus
  })

  ipcMain.handle('system:current', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    assertNoIpcArgument(request)
    if (!currentSystemService) throw new Error('Current-system service is not ready yet')
    await accountInitialization
    return currentSystemService.getCurrentSystem()
  })

  ipcMain.handle('anomaly:record-probe', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated = validateProbeScanRecordRequest(request)
    if (!accountService || !esiClient || !probeScanStore) {
      throw new Error('Probe Scanner snapshot service is not ready yet')
    }
    await accountInitialization
    const authorized = await accountService.getAuthorizedSession()
    if (!authorized) throw new Error('Connect an EVE Online character')

    // A forced location read prevents a scan copied just after a gate jump from
    // silently inheriting the renderer's previous-system snapshot.
    const location = await esiClient.getAuthenticatedCharacterLocation(
      authorized.session.characterId,
      authorized.accessToken,
      true
    )
    let canonicalSystemName = validated.systemName
    try {
      canonicalSystemName = (await esiClient.getSolarSystem(location.solarSystemId)).name
    } catch {
      // The forced authenticated location is authoritative; the renderer name
      // remains a display-only fallback if public universe metadata is offline.
    }

    const parsed = parseProbeClipboard(validated.rawProbeText)
    if (parsed.rows.length === 0) throw new TypeError('Probe Scanner contains no recognized rows')
    return probeScanStore.record(summarizeProbeScan(
      location.solarSystemId,
      canonicalSystemName,
      parsed.rows,
      parsed.rejected,
      validated.observedAt
    ))
  })

  ipcMain.handle('anomaly:nearby', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated = validateNearbyAnomalyRequest(request)
    if (!nearbyAnomalyService) throw new Error('Nearby-anomaly service is not ready yet')
    return nearbyAnomalyService.getNearby(validated)
  })

  ipcMain.handle('pve:nearby', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated = validateNearbyPveRequest(request)
    if (!nearbyPveService) throw new Error('Nearby-PvE service is not ready yet')
    return nearbyPveService.getNearby(validated)
  })

  ipcMain.handle('pilot:context', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const query = parsePilotContextQuery(request)
    if (!accountService) throw new Error('Account service is not ready yet')
    if (!pilotContextService) throw new Error('Pilot Context is not ready yet')

    await accountInitialization
    const authorized = await accountService.getAuthorizedSession()
    if (!authorized) return null

    try {
      return await pilotContextService.getContext({
        characterId: authorized.session.characterId,
        accessToken: authorized.accessToken,
        forceRefresh: query.forceRefresh,
        excludeOwnCharacter: query.excludeOwnCharacter
      })
    } catch {
      // Fixed message guarantees that neither bearer token nor upstream body reaches renderer.
      throw new Error('Could not retrieve Pilot Context')
    }
  })

  ipcMain.handle('kill-alerts:poll', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated = parseKillAlertPollRequest(request)
    if (!killAlertService) throw new Error('Kill-alert service is not ready yet')

    const result = await killAlertService.pollOnce(validated)
    const publicResponse = toPublicKillAlertPollResponse(result)
    const typeIds = collectKillAlertTypeIds(publicResponse)
    if (!esiClient || typeIds.length === 0) return publicResponse

    try {
      const names = await esiClient.getUniverseNames(typeIds)
      return enrichKillAlertShipNames(publicResponse, names)
    } catch {
      return {
        ...publicResponse,
        warnings: [
          ...publicResponse.warnings,
          'ESI: kill-alert ship names are temporarily unavailable'
        ]
      }
    }
  })

  ipcMain.handle('industry:character', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    assertStrictRequestKeys(request, ['forceRefresh'], 'industry character')
    if ((request as { forceRefresh?: unknown }).forceRefresh !== undefined && typeof (request as { forceRefresh?: unknown }).forceRefresh !== 'boolean') throw new TypeError('Invalid industry refresh mode')
    if (!industryService) throw new Error('Industry service is not ready yet')
    return industryService.getCharacter((request as { forceRefresh?: boolean }).forceRefresh)
  })
  ipcMain.handle('industry:monitor:get', async (event, request: unknown) => {
    assertTrustedIpcEvent(event); assertNoIpcArgument(request)
    if (!industryMonitor) throw new Error('Монитор ещё загружается')
    return industryMonitor.snapshot()
  })
  ipcMain.handle('industry:monitor:set', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!industryMonitor) throw new Error('Монитор ещё загружается')
    return industryMonitor.configure(request)
  })
  ipcMain.handle('industry:production:get', async (event, request: unknown) => {
    assertTrustedIpcEvent(event); assertStrictRequestKeys(request, ['forceRefresh'], 'production history')
    if (request.forceRefresh !== undefined && typeof request.forceRefresh !== 'boolean') throw new TypeError('Некорректное обновление производства')
    if (!industryProduction) throw new Error('История производства ещё загружается')
    return industryProduction.snapshot(request.forceRefresh as boolean | undefined)
  })
  ipcMain.handle('industry:production:save', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!industryProduction) throw new Error('История производства ещё загружается')
    return industryProduction.save(request)
  })
  ipcMain.handle('industry:connect', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    assertNoIpcArgument(request)
    if (!accountService) throw new Error('Account service is not ready yet')
    await accountInitialization
    currentMultiAccountStatus = await accountService.connectCharacter({ industry: true })
    currentAccountStatus = await accountService.getStatus()
    return currentMultiAccountStatus
  })
  ipcMain.handle('industry:ledger', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    assertStrictRequestKeys(request, ['forceRefresh'], 'industry ledger')
    const refresh = (request as { forceRefresh?: unknown }).forceRefresh
    if (refresh !== undefined && typeof refresh !== 'boolean') throw new TypeError('Invalid ledger refresh mode')
    if (!industryService) throw new Error('Industry service is not ready yet')
    return industryService.getLedger(refresh)
  })
  ipcMain.handle('industry:scan', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!industryService) throw new Error('Industry service is not ready yet')
    const senderId = event.sender.id
    if (industryScans.has(senderId)) throw new Error('Предыдущий расчёт ещё выполняется')
    const controller = new AbortController()
    industryScans.set(senderId, controller)
    try {
      return await industryService.scan(request as IndustryScanRequest, progress => {
        if (!event.sender.isDestroyed()) event.sender.send('industry:progress', progress)
      }, controller.signal)
    } finally { industryScans.delete(senderId) }
  })
  ipcMain.handle('industry:factories', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!industryService) throw new Error('Industry service is not ready yet')
    return industryService.factories(request as IndustryFactoryRequest)
  })
  ipcMain.handle('industry:liquidity', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!industryService) throw new Error('Industry service is not ready yet')
    return industryService.liquidity(request as import('../shared/industry').IndustryLiquidityRequest)
  })
  ipcMain.handle('industry:cancel', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    assertNoIpcArgument(request)
    industryScans.get(event.sender.id)?.abort()
  })

  ipcMain.handle('market:search', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!marketService) throw new Error('Market service is not ready yet')
    if (!isRecord(request)) throw new TypeError('Invalid item-search request')
    const allowed = new Set(['query', 'limit', 'forceRefresh'])
    if (Object.keys(request).some((key) => !allowed.has(key))) {
      throw new TypeError('Item-search request contains unknown fields')
    }
    if (typeof request.query !== 'string') throw new TypeError('Item name must be text')
    if (
      request.limit !== undefined &&
      (!Number.isSafeInteger(request.limit) || (request.limit as number) < 1 || (request.limit as number) > 50)
    ) {
      throw new RangeError('Search limit must be from 1 to 50')
    }
    if (request.forceRefresh !== undefined && typeof request.forceRefresh !== 'boolean') {
      throw new TypeError('Invalid market refresh mode')
    }
    return marketService.searchInventoryTypes(
      request.query,
      request.limit as number | undefined,
      request.forceRefresh === true
    )
  })

  ipcMain.handle('market:compare', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!marketService) throw new Error('Market service is not ready yet')
    assertStrictRequestKeys(
      request,
      ['typeId', 'quantity', 'hubIds', 'includeHistory', 'includeDepth', 'forceRefresh'],
      'market comparison'
    )
    return marketService.compareHubs(request as unknown as MarketComparisonRequest)
  })

  ipcMain.handle('market:appraise', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!marketService) throw new Error('Market service is not ready yet')
    assertStrictRequestKeys(request, ['text', 'hubIds', 'forceRefresh'], 'item valuation')
    return marketService.appraiseText(request as unknown as MarketAppraisalRequest)
  })

  ipcMain.handle('route:analyze', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!routeIntelService) throw new Error('Route-intel service is not ready yet')
    assertStrictRequestKeys(
      request,
      [
        'origin',
        'destination',
        'mode',
        'forceRefresh',
        'includeRecentPublicKillmails',
        'hauling'
      ],
      'route'
    )
    return routeIntelService.analyze(request as unknown as RouteIntelRequest)
  })

  ipcMain.handle('route:set-waypoints', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    const validated = validateRouteWaypointRequest(request as never)
    if (!accountService || !esiClient) throw new Error('EVE service is not ready yet')
    await accountInitialization
    const authorized = await accountService.getAuthorizedSession()
    if (!authorized) throw new Error('Connect an EVE Online character')
    if (!authorized.session.scopes.includes(ESI_UI_SCOPES.waypoint)) {
      throw new Error(
        'Autopilot needs the esi-ui.write_waypoint.v1 scope. Disconnect and reconnect the character.'
      )
    }
    return esiClient.setAuthenticatedAutopilotRoute(
      validated.destinationIds,
      authorized.accessToken
    )
  })

  ipcMain.handle('economy:snapshot', async (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    if (!personalEconomyService) throw new Error('Personal-economy service is not ready yet')
    if (request !== undefined) {
      assertStrictRequestKeys(request, ['forceRefresh'], 'personal economy')
      if ((request as Record<string, unknown>).forceRefresh !== undefined &&
        typeof (request as Record<string, unknown>).forceRefresh !== 'boolean') {
        throw new TypeError('Invalid personal-economy refresh mode')
      }
    }
    return personalEconomyService.getSnapshot(
      request === undefined ? {} : request as { forceRefresh?: boolean }
    )
  })

  ipcMain.handle('encounter:record', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    return requireEncounterJournalStore().record(request)
  })

  ipcMain.handle('encounter:list', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    return requireEncounterJournalStore().listRecent(request ?? {})
  })

  ipcMain.handle('encounter:search-pilot', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    return requireEncounterJournalStore().searchPilot(request)
  })

  ipcMain.handle('encounter:count', (event, request: unknown) => {
    assertTrustedIpcEvent(event)
    assertNoIpcArgument(request)
    return requireEncounterJournalStore().count()
  })

  ipcMain.handle('pro:wormhole:get', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'wormhole_chain_mapper')
    assertNoIpcArgument(request)
    return requireWormholeChainStore().getChain()
  })

  ipcMain.handle('pro:hunter:plan', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'hunter_planner')
    assertStrictRequestKeys(
      request,
      ['timezoneOffsetMinutes', 'activityBucketMinutes', 'since'],
      'Hunter Planner'
    )
    if (request.since !== undefined && typeof request.since !== 'string') {
      throw new TypeError('Invalid Hunter Planner date')
    }
    const typed = request as unknown as HunterPlanRequest
    const snapshots = requireEncounterJournalStore().listForAnalysis(typed.since)
    return buildHunterPlan(snapshots, {
      timezoneOffsetMinutes: typed.timezoneOffsetMinutes,
      activityBucketMinutes: typed.activityBucketMinutes
    })
  })

  ipcMain.handle('pro:market:evaluate', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'market_opportunity_radar')
    assertStrictRequestKeys(
      request,
      [
        'typeId', 'typeName', 'quantity', 'originHubId', 'destinationHubId',
        'unitVolumeM3', 'feeRate', 'haulingCostIsk', 'riskAversion', 'forceRefresh'
      ],
      'Market Opportunity Radar'
    )
    if (!marketOpportunityService) throw new Error('Market Opportunity Radar is not ready yet')
    return marketOpportunityService.evaluate(
      request as unknown as MarketOpportunityEvaluationRequest
    )
  })

  ipcMain.handle('pro:wormhole:upsert-system', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'wormhole_chain_mapper')
    assertStrictRequestKeys(
      request,
      ['id', 'solarSystemId', 'name', 'isHome', 'seenAt'],
      'wormhole-chain system'
    )
    return requireWormholeChainStore().upsertSystem(request as unknown as WormholeSystemUpsertInput)
  })

  ipcMain.handle('pro:wormhole:set-home', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'wormhole_chain_mapper')
    assertStrictRequestKeys(request, ['systemNodeId'], 'wormhole-chain home system')
    if (typeof request.systemNodeId !== 'string') throw new TypeError('Invalid home system')
    return requireWormholeChainStore().setHome(request.systemNodeId)
  })

  ipcMain.handle('pro:wormhole:upsert-connection', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'wormhole_chain_mapper')
    assertStrictRequestKeys(
      request,
      [
        'id', 'fromSystemNodeId', 'toSystemNodeId', 'fromSignatureId',
        'reverseSignatureId', 'wormholeCode', 'massStatus', 'lifeStatus',
        'discoveredAt', 'updatedAt', 'expiresAt'
      ],
      'wormhole-chain connection'
    )
    return requireWormholeChainStore().upsertConnection(
      request as unknown as WormholeConnectionUpsertInput
    )
  })

  ipcMain.handle('pro:wormhole:update-status', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'wormhole_chain_mapper')
    assertStrictRequestKeys(request, ['connectionId', 'statusText'], 'wormhole status')
    if (typeof request.connectionId !== 'string' || typeof request.statusText !== 'string') {
      throw new TypeError('Invalid wormhole status')
    }
    if (request.statusText.length > 20_000) throw new RangeError('Wormhole description is too large')
    return requireWormholeChainStore().updateConnectionStatusFromText(
      request.connectionId,
      request.statusText
    )
  })

  ipcMain.handle('pro:wormhole:record-probe', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'wormhole_chain_mapper')
    assertStrictRequestKeys(
      request,
      ['solarSystemId', 'systemName', 'rawProbeText', 'observedAt'],
      'Probe Scanner wormhole chain'
    )
    const typed = request as unknown as WormholeProbeScanRecordRequest
    if (
      !Number.isSafeInteger(typed.solarSystemId) || typed.solarSystemId <= 0 ||
      typeof typed.systemName !== 'string' ||
      typeof typed.rawProbeText !== 'string' ||
      typeof typed.observedAt !== 'string'
    ) throw new TypeError('Invalid Probe Scanner text for wormhole chain')
    if (typed.rawProbeText.length > 250_000) throw new RangeError('Probe Scanner text is too large')
    const store = requireWormholeChainStore()
    const source = store.upsertSystem({
      solarSystemId: typed.solarSystemId,
      name: typed.systemName,
      seenAt: typed.observedAt
    })
    store.recordProbeScan(source.id, parseProbeRows(typed.rawProbeText), typed.observedAt)
    return store.getChain()
  })

  ipcMain.handle('pro:doctrine:list', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'dscan_doctrine_matcher')
    assertNoIpcArgument(request)
    return requireDoctrineTemplateStore().list()
  })

  ipcMain.handle('pro:doctrine:save', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'dscan_doctrine_matcher')
    return requireDoctrineTemplateStore().save(request)
  })

  ipcMain.handle('pro:doctrine:delete', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'dscan_doctrine_matcher')
    assertStrictRequestKeys(request, ['id'], 'doctrine removal')
    if (typeof request.id !== 'string') throw new TypeError('Invalid doctrine ID')
    return requireDoctrineTemplateStore().delete(request.id)
  })

  ipcMain.handle('pro:doctrine:match', (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'dscan_doctrine_matcher')
    assertStrictRequestKeys(request, ['templateId', 'rawDscanText'], 'doctrine comparison')
    if (typeof request.templateId !== 'string' || typeof request.rawDscanText !== 'string') {
      throw new TypeError('Invalid doctrine-comparison request')
    }
    if (request.rawDscanText.length > 250_000) throw new RangeError('D-scan text is too large')
    const parsedRows = parseDscanRows(request.rawDscanText)
    const rows = parsedRows.length > 0
      ? parsedRows
      : parseSimpleDoctrineRows(request.rawDscanText)
    if (rows.length > 2_000) throw new RangeError('D-scan contains more than 2000 objects')
    return matchDscanDoctrine(rows, requireDoctrineTemplateStore().get(request.templateId))
  })

  ipcMain.handle('pro:fleet:list', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'corp_fleet_intel')
    assertNoIpcArgument(request)
    const workspaces = await requireSharedWorkspaceService().listWorkspaces()
    return workspaces.map(toPublicSharedWorkspaceSummary)
  })

  ipcMain.handle('pro:fleet:get', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'corp_fleet_intel')
    const workspaceId = parseGetSharedWorkspaceRequest(request).workspaceId
    return toPublicSharedWorkspaceSnapshot(
      await requireSharedWorkspaceService().getWorkspace(workspaceId)
    )
  })

  ipcMain.handle('pro:fleet:create', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'corp_fleet_intel')
    const { name } = parseCreateSharedWorkspaceRequest(request)
    const result = await requireSharedWorkspaceService().createWorkspace({
      workspaceId: `workspace-${randomUUID()}`,
      name,
      policyVersion: 1,
      mutationId: `mutation-${randomUUID()}`
    })
    return toPublicSharedWorkspaceSnapshot(result.workspace)
  })

  ipcMain.handle('pro:fleet:consent:accept', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'corp_fleet_intel')
    const parsed = parseAcceptSharedWorkspaceConsentRequest(request)
    const result = await requireSharedWorkspaceService().acceptConsent(parsed.workspaceId, {
      policyVersion: parsed.policyVersion,
      scopes: parsed.scopes,
      expectedWorkspaceRevision: parsed.expectedWorkspaceRevision,
      mutationId: `mutation-${randomUUID()}`
    })
    return toPublicSharedWorkspaceSnapshot(result.workspace)
  })

  ipcMain.handle('pro:fleet:consent:revoke', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'corp_fleet_intel')
    const parsed = parseRevokeSharedWorkspaceConsentRequest(request)
    const result = await requireSharedWorkspaceService().revokeConsent(parsed.workspaceId, {
      expectedWorkspaceRevision: parsed.expectedWorkspaceRevision,
      mutationId: `mutation-${randomUUID()}`
    })
    return toPublicSharedWorkspaceSnapshot(result.workspace)
  })

  ipcMain.handle('pro:fleet:member:add', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'corp_fleet_intel')
    const parsed = parseAddSharedWorkspaceMemberRequest(request)
    const result = await requireSharedWorkspaceService().addMember(parsed.workspaceId, {
      characterId: String(parsed.characterId),
      characterName: parsed.characterName,
      role: parsed.role,
      expectedWorkspaceRevision: parsed.expectedWorkspaceRevision,
      mutationId: `mutation-${randomUUID()}`
    })
    return toPublicSharedWorkspaceSnapshot(result.workspace)
  })

  ipcMain.handle('pro:fleet:mutation:apply', async (event, request: unknown) => {
    assertProFeatureIpcEvent(event, 'corp_fleet_intel')
    const parsed = parseApplySharedWorkspaceMutationRequest(request)
    return toPublicSharedWorkspaceMutationResult(
      await requireSharedWorkspaceService().applyMutation(parsed.workspaceId, parsed.mutation)
    )
  })
}

function ensureServicesInitialized(): Promise<void> {
  if (servicesInitialization) return servicesInitialization
  servicesInitialization = initializeServices().catch((error) => {
    servicesInitialization = null
    throw error
  })
  return servicesInitialization
}

function ensureAccountServicesInitialized(): Promise<void> {
  if (accountServicesInitialization) return accountServicesInitialization
  accountServicesInitialization = initializeAccountServices().catch((error) => {
    accountServicesInitialization = null
    throw error
  })
  return accountServicesInitialization
}

function waitForSafeStorageStartup(): Promise<void> {
  if (SAFE_STORAGE_STARTUP_DELAY_MS === 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, SAFE_STORAGE_STARTUP_DELAY_MS)
  })
}

async function initializeAccountServices(): Promise<void> {
  const userDataDirectory = app.getPath('userData')

  // One isolated Chromium session serves SSO, ESI and the entitlement backend.
  const apiSession = session.fromPartition('eve-api-network', { cache: false })
  try {
    await configureSystemProxySession(apiSession)
  } catch {
    apiSession.setUserAgent(API_NETWORK_USER_AGENT)
  }
  apiFetch = createProxyAwareFetch(apiSession)

  accountService = new EveMultiAccountService({
    dataDirectory: userDataDirectory,
    clientId: FLY_SAFE_EVE_CLIENT_ID,
    // Until Fly Safe is signed by a stable Developer ID, macOS treats every update as a new
    // application and can block safeStorage behind a password prompt. Keep OAuth credentials
    // in memory on macOS; access ends on app quit and no plaintext token is written to disk.
    credentialPersistence: process.platform === 'darwin' ? 'memory' : 'encrypted',
    protector: {
      isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
      encryptString: async (plaintext) => (
        new Uint8Array(await safeStorage.encryptStringAsync(plaintext))
      ),
      decryptString: async (ciphertext) => (
        await safeStorage.decryptStringAsync(Buffer.from(ciphertext))
      ).result
    },
    openExternal: async (authorizationUrl) => {
      await shell.openExternal(authorizationUrl)
    },
    clientFactory: (options) => new EveSsoClient({
      ...options,
      fetch: apiFetch!
    })
  })

  // Restoration is intentionally non-blocking. Account IPC awaits this promise.
  accountInitializationComplete = false
  accountInitialization = waitForSafeStorageStartup()
    .then(() => accountService!.restore())
    .then(
      async (status) => {
        currentAccountStatus = status
        currentMultiAccountStatus = accountService
          ? await accountService.getAccountsStatus()
          : null
      },
      async () => {
        currentAccountStatus = accountService
          ? await accountService.getStatus()
          : null
        currentMultiAccountStatus = accountService
          ? await accountService.getAccountsStatus().catch(() => null)
          : null
      }
    )
    .finally(() => {
      accountInitializationComplete = true
    })
}

async function refreshAccountSnapshots(): Promise<EveAccountStatus> {
  if (!accountService) throw new Error('Account service is not ready yet')
  currentAccountStatus = await accountService.getStatus()
  currentMultiAccountStatus = await accountService.getAccountsStatus()
  return currentAccountStatus
}

async function restoreOwnerAfterActiveCharacterRemoval(
  removedCharacterId: number
): Promise<EveMultiAccountStatus> {
  if (!accountService) throw new Error('Account service is not ready yet')
  const snapshot = await accountService.getAccountsStatus()
  if (
    snapshot.activeCharacterId !== null &&
    snapshot.activeCharacterId !== removedCharacterId
  ) return snapshot

  const fallback = snapshot.characters.find((character) => character.credentialStored)
  if (!fallback) return snapshot

  await accountService.selectActiveCharacter(fallback.characterId)
  return accountService.restoreCharacter(fallback.characterId)
}

async function initializeServices(): Promise<void> {
  await ensureAccountServicesInitialized()
  const userDataDirectory = app.getPath('userData')
  const intelDatabasePath = join(userDataDirectory, 'intel-cache.sqlite')
  const systemDatabasePath = join(userDataDirectory, 'system-intel-cache.sqlite')
  const pilotWatchlistDatabasePath = join(userDataDirectory, 'pilot-watchlist.sqlite')
  const encounterJournalDatabasePath = join(userDataDirectory, 'encounter-journal.sqlite')
  const wormholeChainDatabasePath = join(userDataDirectory, 'wormhole-chain.sqlite')
  const probeScanDatabasePath = join(userDataDirectory, 'probe-scan-history.sqlite')
  const doctrineDatabasePath = join(userDataDirectory, 'doctrine-templates.sqlite')

  if (!apiFetch || !accountService) throw new Error('Account services are not ready yet')
  const proxyFetch = apiFetch
  const combatBackendBaseUrl = getCombatRelayBaseUrl()
  const combatFetch = combatBackendBaseUrl
    ? createZkillRelayFetch({
        fetch: proxyFetch,
        relayBaseUrl: combatBackendBaseUrl,
        getAccessToken: async () => (
          await accountService!.getAuthorizedSession()
        )?.accessToken ?? null
      })
    : proxyFetch
  const zkillBaseUrl = combatBackendBaseUrl
    ? `${combatBackendBaseUrl}${ZKILL_RELAY_PATH}`
    : undefined
  const r2z2BaseUrl = combatBackendBaseUrl
    ? `${combatBackendBaseUrl}${R2Z2_RELAY_PATH}`
    : undefined
  const zkillNetworkOptions = {
    fetch: combatFetch,
    userAgent: API_NETWORK_USER_AGENT,
    timeoutMs: COMBAT_API_REQUEST_BUDGET_MS,
    maxAttempts: 1,
    ...(zkillBaseUrl ? { baseUrl: zkillBaseUrl } : {})
  }

  intelService = new IntelService(intelDatabasePath, {
    esi: { fetch: proxyFetch, userAgent: API_NETWORK_USER_AGENT },
    zkill: zkillNetworkOptions
  })
  systemCache = new Cache(systemDatabasePath)
  esiClient = new EsiClient(systemCache, {
    fetch: proxyFetch,
    userAgent: API_NETWORK_USER_AGENT
  })
  systemIntelService = new SystemIntelService(systemDatabasePath, {
    cache: systemCache,
    esiClient,
    zkill: zkillNetworkOptions
  })
  marketService = new MarketService(systemDatabasePath, {
    cache: systemCache,
    esiClient
  })
  routeIntelService = new RouteIntelService({
    resolveSolarSystemId: (name, forceRefresh) =>
      esiClient!.resolveSolarSystemId(name, forceRefresh),
    getRouteSystems: (originId, destinationId, mode, forceRefresh) =>
      esiClient!.getRouteSystems(originId, destinationId, mode, forceRefresh),
    getSystemMetadata: async (solarSystemId, forceRefresh) => {
      const system = await esiClient!.getSolarSystem(solarSystemId, forceRefresh)
      return {
        id: system.id,
        name: system.name,
        securityStatus: system.securityStatus,
        cached: system.cached
      }
    },
    getSystemKills: async (forceRefresh) => {
      const result = await esiClient!.getSystemKills(forceRefresh)
      return { ...result, fetchedAt: new Date().toISOString() }
    },
    getSystemJumps: async (forceRefresh) => {
      const result = await esiClient!.getSystemJumps(forceRefresh)
      return { ...result, fetchedAt: new Date().toISOString() }
    },
    systemIntel: new ZkillRouteSystemIntelLookup(systemIntelService)
  }, {
    metadataConcurrency: 4,
    recentIntelConcurrency: 2,
    maxRecentIntelSystems: 10
  })
  marketOpportunityService = new MarketOpportunityService(marketService, routeIntelService)
  currentSystemService = new CurrentSystemService(
    accountService,
    esiClient,
    systemIntelService
  )
  pilotContextService = new PilotContextService(esiClient)
  pilotWatchlistStore = new PilotWatchlistStore(pilotWatchlistDatabasePath)
  encounterJournalStore = new EncounterJournalStore(encounterJournalDatabasePath)
  wormholeChainStore = new WormholeChainStore(wormholeChainDatabasePath)
  probeScanStore = new ProbeScanStore(probeScanDatabasePath)
  nearbyAnomalyService = new NearbyAnomalyService(probeScanStore, {
    getRouteSystems: (originId, destinationId) =>
      esiClient!.getRouteSystems(originId, destinationId, 'shortest'),
    getSystemMetadata: async (solarSystemId) => {
      const system = await esiClient!.getSolarSystem(solarSystemId)
      return {
        id: system.id,
        name: system.name,
        securityStatus: system.securityStatus
      }
    }
  })
  nearbyPveService = new NearbyPveService({
    getSystem: async (solarSystemId) => {
      const system = await esiClient!.getSolarSystem(solarSystemId)
      return {
        id: system.id,
        name: system.name,
        securityStatus: system.securityStatus,
        stargateIds: system.stargateIds
      }
    },
    getStargate: async (stargateId) => {
      const stargate = await esiClient!.getStargate(stargateId)
      return {
        id: stargate.id,
        systemId: stargate.systemId,
        destinationSystemId: stargate.destinationSystemId
      }
    },
    getSystemKills: () => esiClient!.getSystemKills(),
    getSystemJumps: () => esiClient!.getSystemJumps()
  })
  doctrineTemplateStore = new DoctrineTemplateStore(doctrineDatabasePath)
  personalEconomyService = new PersonalEconomyService(accountService, esiClient)
  industryService = new IndustryService(accountService, esiClient, systemCache)
  const industryIdentity = async (): Promise<number | null> => (await accountService!.getAuthorizedSession())?.session.characterId ?? null
  industryProduction = new IndustryProductionService(industryService, systemCache, industryIdentity, INDUSTRY_CATALOG)
  // Separate quote state prevents background cycles from replacing manual factory inputs.
  industryMonitor = new IndustryMonitorService(new IndustryService(accountService, esiClient, systemCache), systemCache, industryIdentity, (deal, characterId) => {
    if (!nativeAlertService || !uiSettingsStore?.get().settings.backgroundNotificationsEnabled) return false
    return nativeAlertService.show({ kind: 'info', workspace: 'industry', title: 'Выгодный BPC · Fly Safe',
      body: `${deal.productName.slice(0, 100)} · контракт #${deal.contractId} · BUY +${Math.round(deal.profit).toLocaleString('ru-RU')} ISK (${deal.margin.toFixed(1)}%). Нужно ${Math.round(deal.capital).toLocaleString('ru-RU')} ISK. Проверьте цены перед оплатой.`,
      dedupeKey: `bpc:${characterId}:${deal.contractId}`, force: true, silent: false }).shown
  })
  killAlertService = new KillAlertService(new R2z2Client({
    fetch: combatFetch,
    userAgent: API_NETWORK_USER_AGENT,
    timeoutMs: COMBAT_API_REQUEST_BUDGET_MS,
    ...(r2z2BaseUrl ? { baseUrl: r2z2BaseUrl } : {})
  }))

}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
    app.setName('Fly Safe')
    if (process.platform === 'win32') app.setAppUserModelId('dev.evelocalintel.app')
    uiSettingsStore = new UiSettingsStore(join(app.getPath('userData'), 'ui-settings.json'))
    await ensureAccountServicesInitialized()
    await ensureServicesInitialized()
    registerIpcHandlers()
    createApplicationMenu()
    createWindow()
    trayController = new TrayController({
      getWindow: () => mainWindow,
      ensureWindow: () => {
        if (!mainWindow || mainWindow.isDestroyed()) createWindow()
        else showMainWindow()
      },
      quit: () => app.quit(),
      onNavigate: sendWorkspaceNavigation
    })
    trayController.start()
    nativeAlertService = new NativeAlertService({
      getWindow: () => mainWindow,
      isSupported: () => Notification.isSupported(),
      onActivate: (workspace) => trayController?.navigate(workspace)
    })
    industryMonitor?.start()
    industryProduction?.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showMainWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (!backgroundModeEnabled() && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  beginShutdown()
})

function beginShutdown(): void {
  isQuitting = true
  shutdownServices()
}

function shutdownServices(): void {
  if (servicesShutdown) return
  servicesShutdown = true

  runShutdownStep(() => industryMonitor?.stop())
  runShutdownStep(() => industryProduction?.stop())
  runShutdownStep(() => killAlertService?.stop())
  runShutdownStep(() => intelService?.close())
  runShutdownStep(() => pilotWatchlistStore?.close())
  runShutdownStep(() => encounterJournalStore?.close())
  runShutdownStep(() => wormholeChainStore?.close())
  runShutdownStep(() => probeScanStore?.close())
  runShutdownStep(() => doctrineTemplateStore?.close())
  runShutdownStep(() => marketService?.close())
  runShutdownStep(() => nativeAlertService?.dispose())
  runShutdownStep(() => trayController?.destroy())
  trayController = null
  nativeAlertService = null
  // SystemIntelService uses the injected systemCache, so only its owner closes it.
  runShutdownStep(() => systemCache?.close())
}

function runShutdownStep(step: () => void): void {
  try {
    step()
  } catch {
    // Shutdown must continue even if one already-closed local service rejects.
  }
}

function showMainWindow(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function sendWorkspaceNavigation(workspace: NativeAlertWorkspace): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  const send = (): void => {
    if (!window.isDestroyed()) window.webContents.send('app:navigate', workspace)
  }
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', send)
  else send()
}

function minimizeToTrayEnabled(): boolean {
  return uiSettingsStore?.get().settings.minimizeToTray ?? true
}

function backgroundModeEnabled(): boolean {
  return Boolean(trayController?.status().available && minimizeToTrayEnabled())
}

function isTrustedIpcEvent(event: Electron.IpcMainInvokeEvent): boolean {
  const window = mainWindow
  const senderDestroyed = event.sender.isDestroyed()
  const frame = event.senderFrame
  const frameDestroyed = frame === null || frame.isDestroyed()
  const mainFrame = senderDestroyed ? null : event.sender.mainFrame

  return isTrustedIpcSender(
    {
      senderUrl: senderDestroyed ? null : event.sender.getURL(),
      frameUrl: frameDestroyed ? null : frame.url,
      senderMatchesMainWindow:
        window !== null && !window.isDestroyed() && event.sender === window.webContents,
      frameIsMainFrame:
        !frameDestroyed &&
        mainFrame !== null &&
        frame.processId === mainFrame.processId &&
        frame.routingId === mainFrame.routingId,
      senderDestroyed,
      frameDestroyed
    },
    rendererTrustPolicy
  )
}

function assertTrustedIpcEvent(event: Electron.IpcMainInvokeEvent): void {
  assertUnlicensedIpcEvent(event)
  if (!currentAccountStatus?.connected) {
    throw new Error('Sign in through an EVE Online character is required')
  }
}

function assertProFeatureIpcEvent(
  event: Electron.IpcMainInvokeEvent,
  feature: ProFeatureId
): void {
  assertTrustedIpcEvent(event)
  void feature
}

function assertUnlicensedIpcEvent(event: Electron.IpcMainInvokeEvent): void {
  if (!isTrustedIpcEvent(event)) throw new Error('Untrusted IPC source')
}

function requireSharedWorkspaceService(): SharedWorkspaceService {
  if (sharedWorkspaceService) return sharedWorkspaceService
  if (!accountService || !apiFetch) throw new Error('Corp/Fleet backend is not ready yet')
  sharedWorkspaceService = new SharedWorkspaceService({
    baseUrl: getSubscriptionBackendBaseUrl(),
    account: {
      // Corp/Fleet operations are always performed as the active character. The bearer token
      // never crosses preload/renderer and is attached only inside SharedWorkspaceService.
      getAuthorizedSession: () => accountService?.getAuthorizedSession() ?? Promise.resolve(null),
      getOwnerAuthorizedSession: () => accountService?.getAuthorizedSession() ?? Promise.resolve(null)
    },
    fetch: apiFetch
  })
  return sharedWorkspaceService
}

function getSubscriptionBackendBaseUrl(): string {
  if (subscriptionBackendBaseUrl !== null) return subscriptionBackendBaseUrl
  try {
    subscriptionBackendBaseUrl = resolveSubscriptionBackendUrl({
      userDataDirectory: app.getPath('userData'),
      resourcesDirectory: process.resourcesPath
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid backend configuration'
    console.error(`[subscription-backend] ${message}`)
    subscriptionBackendBaseUrl = ''
  }
  return subscriptionBackendBaseUrl
}

function getCombatRelayBaseUrl(): string {
  if (combatRelayBaseUrl !== null) return combatRelayBaseUrl
  try {
    combatRelayBaseUrl = resolveCombatRelayUrl({
      userDataDirectory: app.getPath('userData'),
      resourcesDirectory: process.resourcesPath,
      fallbackUrl: getSubscriptionBackendBaseUrl()
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid combat-relay configuration'
    console.error(`[combat-relay] ${message}`)
    combatRelayBaseUrl = ''
  }
  return combatRelayBaseUrl
}

function assertNoIpcArgument(value: unknown): void {
  if (value !== undefined) throw new TypeError('This request accepts no parameters')
}

function requirePilotWatchlistStore(): PilotWatchlistStore {
  if (!pilotWatchlistStore) throw new Error('Watchlist is not ready yet')
  return pilotWatchlistStore
}

function requireEncounterJournalStore(): EncounterJournalStore {
  if (!encounterJournalStore) throw new Error('Encounter journal is not ready yet')
  return encounterJournalStore
}

function requireWormholeChainStore(): WormholeChainStore {
  if (!wormholeChainStore) throw new Error('Wormhole Chain Store is not ready yet')
  return wormholeChainStore
}

function requireDoctrineTemplateStore(): DoctrineTemplateStore {
  if (!doctrineTemplateStore) throw new Error('Doctrine Template Store is not ready yet')
  return doctrineTemplateStore
}

function requireUiSettingsStore(): UiSettingsStore {
  if (!uiSettingsStore) throw new Error('UI settings are not ready yet')
  return uiSettingsStore
}

function assertStrictRequestKeys(
  value: unknown,
  allowedKeys: readonly string[],
  label: string
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`Invalid ${label} request`)
  const allowed = new Set(allowedKeys)
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} request contains unknown fields`)
  }
}

function parsePilotContextQuery(value: unknown): PilotContextQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new TypeError('Invalid Pilot Context request')

  const allowedKeys = new Set(['forceRefresh', 'excludeOwnCharacter'])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new TypeError('Pilot Context request contains unknown fields')
  }

  const forceRefresh = Object.prototype.hasOwnProperty.call(value, 'forceRefresh')
    ? value.forceRefresh
    : undefined
  const excludeOwnCharacter = Object.prototype.hasOwnProperty.call(value, 'excludeOwnCharacter')
    ? value.excludeOwnCharacter
    : undefined
  if (forceRefresh !== undefined && typeof forceRefresh !== 'boolean') {
    throw new TypeError('forceRefresh must be boolean')
  }
  if (excludeOwnCharacter !== undefined && typeof excludeOwnCharacter !== 'boolean') {
    throw new TypeError('excludeOwnCharacter must be boolean')
  }

  return { forceRefresh, excludeOwnCharacter }
}

function parseSimpleDoctrineRows(value: string): Array<{ type: string }> {
  const rows: Array<{ type: string }> = []
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  for (const [index, line] of lines.entries()) {
    const match = /^(.*?)(?:\s+[x×]\s*(\d+))?$/iu.exec(line)
    const type = match?.[1]?.normalize('NFKC').trim().replace(/\s+/gu, ' ') ?? ''
    const count = match?.[2] ? Number(match[2]) : 1
    if (!type || type.length > 256 || !Number.isSafeInteger(count) || count <= 0 || count > 500) {
      throw new TypeError(`D-scan row ${index + 1} has an invalid format`)
    }
    if (rows.length + count > 2_000) throw new RangeError('D-scan contains more than 2000 objects')
    for (let item = 0; item < count; item += 1) rows.push({ type })
  }
  return rows
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withoutPilot(result: ScanResult, characterId: number): ScanResult {
  const pilots = result.pilots.filter((pilot) => pilot.id !== characterId)
  if (pilots.length === result.pilots.length) return result

  const dangerous = pilots.filter(
    (pilot) => pilot.threatLevel === 'critical' || pilot.threatLevel === 'high'
  ).length
  return {
    ...result,
    pilots,
    summary: {
      ...result.summary,
      total: pilots.length + result.unresolvedNames.length,
      resolved: pilots.length,
      dangerous,
      unknown:
        result.unresolvedNames.length +
        pilots.filter((pilot) => pilot.threatLevel === 'unknown').length,
      cached: pilots.filter((pilot) => pilot.cached).length,
      corporationGroups: groupCorporations(pilots)
    }
  }
}

function groupCorporations(pilots: readonly PilotIntel[]): CorporationGroup[] {
  const groups = new Map<string, CorporationGroup>()
  for (const pilot of pilots) {
    const key = pilot.corporationId === null ? 'unknown' : String(pilot.corporationId)
    const current = groups.get(key)
    if (current) current.count += 1
    else {
      groups.set(key, {
        id: pilot.corporationId,
        name: pilot.corporationName ?? 'Unknown corporation',
        count: 1
      })
    }
  }
  return [...groups.values()].sort(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name)
  )
}
