import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { EveLocalIntelApi, EveMultiAccountStatus } from '../../shared/types'
import {
  hasProFeature,
  PRO_FEATURE_IDS,
  PRO_FEATURES,
  type ProFeatureId
} from '../../shared/pro-features'
import {
  createCharacterRegistry,
  getActiveCharacterContext,
  removeCharacterProfile,
  resolveCharacterAccess,
  selectActiveCharacter,
  upsertCharacterProfile,
  type CharacterProfile,
  type CharacterRegistrySnapshot
} from '../../shared/character-registry'
import {
  rankMarketOpportunities,
  type MarketOpportunityCandidate,
  type MarketOpportunityRadar
} from '../../shared/market-opportunity'
import {
  MARKET_HUBS,
  getMarketHub,
  type MarketFill,
  type MarketHubId,
  type MarketHubQuote
} from '../../shared/market'
import {
  SHARED_WORKSPACE_COLLECTIONS,
  acceptSharedWorkspaceConsent,
  addSharedWorkspaceMember,
  applySharedWorkspaceMutation,
  createSharedWorkspace,
  revokeSharedWorkspaceConsent,
  type SharedWorkspaceRole,
  type SharedWorkspaceShareScope,
  type SharedWorkspaceMutation,
  type SharedWorkspaceSnapshot,
  type SharedWorkspaceSummary
} from '../../shared/shared-workspace'
import {
  findWormholeRouteHome,
  parseWormholeStatusText,
  type WormholeChain,
  type WormholeConnection,
  type WormholeSystemNode
} from '../../shared/wormhole-chain'
import { buildHunterPlan, type HunterPlan } from '../../shared/hunter-planner'
import type { EncounterSnapshot } from '../../shared/encounter-journal'
import {
  DOCTRINE_ROLES,
  matchDscanDoctrine,
  validateDoctrineTemplateInput,
  type DoctrineMatchResult,
  type DoctrineTemplate,
  type DoctrineTemplateInput
} from '../../shared/doctrine-matcher'
import type { DscanShipRole } from '../../shared/clipboard-intel'
import './pro-workspace.css'

export type ProWorkspaceTab =
  | 'characters'
  | 'wormholes'
  | 'hunter'
  | 'radar'
  | 'doctrine'
  | 'fleet'

export interface ProWorkspaceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ProWorkspaceProps {
  initialTab?: ProWorkspaceTab
  initialRegistry?: CharacterRegistrySnapshot
  initialWorkspace?: SharedWorkspaceSnapshot | null
  storage?: ProWorkspaceStorage | null
  clock?: () => string
  onRequestCharacterConnect?: () => void | Promise<void>
  api?: EveLocalIntelApi | null
  currentSystem?: { solarSystemId: number; name: string } | null
  features?: readonly string[] | null
}

export interface MarketRadarDraft {
  typeName: string
  typeId: string
  quantity: string
  unitVolumeM3: string
  originHubId: MarketHubId
  destinationHubId: MarketHubId
  originTotalIsk: string
  destinationTotalIsk: string
  jumps: string
  averageRiskScore: string
  maximumRiskScore: string
  campPatternSystems: string
  feePercent: string
  haulingCostIsk: string
  riskAversionPercent: string
}

export const PRO_WORKSPACE_STORAGE_KEY = 'fly-safe:pro-workspace:v1'
export const SHARED_WORKSPACE_REFRESH_INTERVAL_MS = 15_000

export const DEFAULT_MARKET_RADAR_DRAFT: MarketRadarDraft = {
  typeName: 'Tritanium',
  typeId: '34',
  quantity: '100000',
  unitVolumeM3: '0.01',
  originHubId: 'jita',
  destinationHubId: 'amarr',
  originTotalIsk: '500000',
  destinationTotalIsk: '690000',
  jumps: '9',
  averageRiskScore: '18',
  maximumRiskScore: '42',
  campPatternSystems: '1',
  feePercent: '3.6',
  haulingCostIsk: '35000',
  riskAversionPercent: '50'
}

interface PersistedProWorkspace {
  schemaVersion: 1
  activeCharacterId: number | null
  profiles: Array<Pick<
    CharacterProfile,
    | 'characterId'
    | 'name'
    | 'corporationId'
    | 'corporationName'
    | 'allianceId'
    | 'allianceName'
  >>
  marketDraft: MarketRadarDraft
}

interface LoadedProWorkspace {
  registry: CharacterRegistrySnapshot
  marketDraft: MarketRadarDraft
}

const DEFAULT_CLOCK = (): string => new Date().toISOString()
const ALL_TEAM_SCOPES: SharedWorkspaceShareScope[] = [...SHARED_WORKSPACE_COLLECTIONS]
const PRO_TAB_FEATURES: Readonly<Record<ProWorkspaceTab, ProFeatureId>> = {
  characters: PRO_FEATURES.characters,
  wormholes: PRO_FEATURES.wormhole,
  hunter: PRO_FEATURES.hunter,
  radar: PRO_FEATURES.market,
  doctrine: PRO_FEATURES.doctrine,
  fleet: PRO_FEATURES.fleet
}
const PRO_TAB_ORDER = Object.freeze(Object.keys(PRO_TAB_FEATURES)) as readonly ProWorkspaceTab[]

/** Never let a slower cloud response roll an already rendered room back to an older revision. */
export function preferNewestSharedWorkspaceSnapshot(
  current: SharedWorkspaceSnapshot | null,
  incoming: SharedWorkspaceSnapshot
): SharedWorkspaceSnapshot {
  if (
    current?.workspaceId === incoming.workspaceId &&
    current.revision > incoming.revision
  ) return current
  return incoming
}

/**
 * Renderer persistence is deliberately metadata-only. OAuth tokens, secure
 * credential references, sessions and team records never enter localStorage.
 */
export function serializeProWorkspaceLocalState(
  registry: CharacterRegistrySnapshot,
  marketDraft: MarketRadarDraft
): string {
  const safe: PersistedProWorkspace = {
    schemaVersion: 1,
    activeCharacterId: registry.activeCharacterId,
    profiles: registry.profiles.map((profile) => ({
      characterId: profile.characterId,
      name: profile.name,
      corporationId: profile.corporationId,
      corporationName: profile.corporationName,
      allianceId: profile.allianceId,
      allianceName: profile.allianceName
    })),
    marketDraft: normalizeMarketDraft(marketDraft)
  }
  return JSON.stringify(safe)
}

export function loadProWorkspaceLocalState(
  storage: ProWorkspaceStorage | null,
  now = DEFAULT_CLOCK()
): LoadedProWorkspace {
  const fallback = {
    registry: createCharacterRegistry(now),
    marketDraft: { ...DEFAULT_MARKET_RADAR_DRAFT }
  }
  if (!storage) return fallback

  try {
    const raw = storage.getItem(PRO_WORKSPACE_STORAGE_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.profiles)) {
      return fallback
    }

    let registry = createCharacterRegistry(now)
    for (const candidate of parsed.profiles.slice(0, 64)) {
      if (!isRecord(candidate)) continue
      try {
        registry = upsertCharacterProfile(registry, {
          characterId: candidate.characterId as number,
          name: candidate.name as string,
          corporationId: nullableNumber(candidate.corporationId),
          corporationName: nullableString(candidate.corporationName),
          allianceId: nullableNumber(candidate.allianceId),
          allianceName: nullableString(candidate.allianceName)
        }, now)
      } catch {
        // Ignore individual corrupt profiles without discarding the safe remainder.
      }
    }

    if (typeof parsed.activeCharacterId === 'number' &&
        registry.profiles.some((profile) => profile.characterId === parsed.activeCharacterId)) {
      registry = selectActiveCharacter(registry, parsed.activeCharacterId, now)
    }

    return {
      registry,
      marketDraft: isRecord(parsed.marketDraft)
        ? normalizeMarketDraft(parsed.marketDraft)
        : fallback.marketDraft
    }
  } catch {
    return fallback
  }
}

export function registryFromMultiAccountStatus(
  status: EveMultiAccountStatus,
  now = DEFAULT_CLOCK()
): CharacterRegistrySnapshot {
  let registry = createCharacterRegistry(now)
  for (const character of status.characters) {
    registry = upsertCharacterProfile(registry, {
      characterId: character.characterId,
      name: character.characterName
    }, now)
  }
  if (
    status.activeCharacterId !== null &&
    registry.profiles.some((profile) => profile.characterId === status.activeCharacterId)
  ) {
    registry = selectActiveCharacter(registry, status.activeCharacterId, now)
  }
  return registry
}

export function ProWorkspace({
  initialTab = 'characters',
  initialRegistry,
  initialWorkspace = null,
  storage,
  clock = DEFAULT_CLOCK,
  onRequestCharacterConnect,
  api = null,
  currentSystem = null,
  features = PRO_FEATURE_IDS
}: ProWorkspaceProps): React.JSX.Element {
  const resolvedStorage = useMemo(
    () => storage === undefined ? browserStorage() : storage,
    [storage]
  )
  const [loaded] = useState(() => loadProWorkspaceLocalState(resolvedStorage, clock()))
  const [tab, setTab] = useState<ProWorkspaceTab>(initialTab)
  const [registry, setRegistry] = useState(initialRegistry ?? loaded.registry)
  const [marketDraft, setMarketDraft] = useState<MarketRadarDraft>(loaded.marketDraft)
  const [workspace, setWorkspace] = useState<SharedWorkspaceSnapshot | null>(initialWorkspace)
  const [accountsStatus, setAccountsStatus] = useState<EveMultiAccountStatus | null>(null)
  const [accountsMessage, setAccountsMessage] = useState<string | null>(null)

  const allowedTabs = useMemo(
    () => PRO_TAB_ORDER.filter((candidate) => (
      hasProFeature(features, PRO_TAB_FEATURES[candidate])
    )),
    [features]
  )
  const visibleTab = allowedTabs.includes(tab) ? tab : allowedTabs[0] ?? null

  useEffect(() => {
    if (visibleTab && visibleTab !== tab) setTab(visibleTab)
  }, [tab, visibleTab])

  useEffect(() => {
    if (!api || !hasProFeature(features, PRO_FEATURES.characters)) return
    let active = true
    setAccountsMessage(null)
    void api.getCharactersStatus().then((status) => {
      if (!active) return
      setAccountsStatus(status)
      setRegistry(registryFromMultiAccountStatus(status, clock()))
    }).catch((error) => {
      if (active) setAccountsMessage(errorMessage(error))
    })
    return () => { active = false }
  }, [api, clock, features])

  useEffect(() => {
    if (!resolvedStorage) return
    try {
      resolvedStorage.setItem(
        PRO_WORKSPACE_STORAGE_KEY,
        serializeProWorkspaceLocalState(registry, marketDraft)
      )
    } catch {
      // Storage can be disabled by policy; the workspace still remains usable in memory.
    }
  }, [marketDraft, registry, resolvedStorage])

  const activeCharacter = getActiveCharacterContext(registry)?.profile ?? null
  const radarResult = useMemo(() => buildMarketRadar(marketDraft, clock()), [clock, marketDraft])

  const applyAccountsStatus = (status: EveMultiAccountStatus): void => {
    setAccountsStatus(status)
    setAccountsMessage(status.error)
    setRegistry(registryFromMultiAccountStatus(status, clock()))
  }

  return (
    <section className="pro-workspace" aria-labelledby="pro-workspace-title">
      <header className="pro-hero">
        <div>
          <p className="eyebrow">Fly Safe · operations</p>
          <h1 id="pro-workspace-title">Pilot and fleet center</h1>
          <p>Characters, trade opportunities, and shared corporation data in one workspace.</p>
        </div>
        <div className="pro-active-character" data-connected={activeCharacter ? 'true' : 'false'}>
          <span aria-hidden="true" />
          {activeCharacter ? `Active: ${activeCharacter.name}` : 'No character selected'}
        </div>
      </header>

      <nav className="pro-tabs" role="tablist" aria-label="Fly Safe sections">
        {allowedTabs.includes('characters') ? <ProTabButton id="characters" current={visibleTab} onSelect={setTab}>
          Characters <small>{registry.profiles.length}</small>
        </ProTabButton> : null}
        {allowedTabs.includes('wormholes') ? <ProTabButton id="wormholes" current={visibleTab} onSelect={setTab}>
          Wormhole Chain
        </ProTabButton> : null}
        {allowedTabs.includes('hunter') ? <ProTabButton id="hunter" current={visibleTab} onSelect={setTab}>
          Hunter Planner
        </ProTabButton> : null}
        {allowedTabs.includes('radar') ? <ProTabButton id="radar" current={visibleTab} onSelect={setTab}>
          Market Radar
        </ProTabButton> : null}
        {allowedTabs.includes('doctrine') ? <ProTabButton id="doctrine" current={visibleTab} onSelect={setTab}>
          Doctrine Matcher
        </ProTabButton> : null}
        {allowedTabs.includes('fleet') ? <ProTabButton id="fleet" current={visibleTab} onSelect={setTab}>
          Corp / Fleet <small>{workspace?.members.length ?? 0}</small>
        </ProTabButton> : null}
      </nav>

      {visibleTab === null ? (
        <div className="pro-panel pro-empty-state" role="status">
          <strong>No section is available</strong>
        </div>
      ) : null}
      {visibleTab === 'characters' ? (
        <CharacterRegistryPanel
          registry={registry}
          now={clock}
          onChange={setRegistry}
          onRequestConnect={onRequestCharacterConnect}
          api={api}
          accountsStatus={accountsStatus}
          remoteMessage={accountsMessage}
          onAccountsChange={applyAccountsStatus}
        />
      ) : null}
      {visibleTab === 'wormholes' ? (
        <WormholeChainPanel api={api} currentSystem={currentSystem} now={clock} />
      ) : null}
      {visibleTab === 'hunter' ? <HunterPlannerPanel api={api} /> : null}
      {visibleTab === 'radar' ? (
        <MarketRadarPanel
          draft={marketDraft}
          result={radarResult}
          onChange={setMarketDraft}
          api={api}
        />
      ) : null}
      {visibleTab === 'doctrine' ? <DoctrineMatcherPanel api={api} now={clock} /> : null}
      {visibleTab === 'fleet' ? (
        <SharedFleetPanel
          activeCharacter={activeCharacter}
          workspace={workspace}
          now={clock}
          onChange={setWorkspace}
          api={api}
        />
      ) : null}
    </section>
  )
}

function ProTabButton({
  id,
  current,
  onSelect,
  children
}: {
  id: ProWorkspaceTab
  current: ProWorkspaceTab | null
  onSelect: (tab: ProWorkspaceTab) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={current === id}
      aria-controls={`pro-panel-${id}`}
      className={current === id ? 'selected' : ''}
      onClick={() => onSelect(id)}
    >
      {children}
    </button>
  )
}

function CharacterRegistryPanel({
  registry,
  now,
  onChange,
  onRequestConnect,
  api,
  accountsStatus,
  remoteMessage,
  onAccountsChange
}: {
  registry: CharacterRegistrySnapshot
  now: () => string
  onChange: (registry: CharacterRegistrySnapshot) => void
  onRequestConnect?: () => void | Promise<void>
  api: EveLocalIntelApi | null
  accountsStatus: EveMultiAccountStatus | null
  remoteMessage: string | null
  onAccountsChange: (status: EveMultiAccountStatus) => void
}): React.JSX.Element {
  const [characterId, setCharacterId] = useState('')
  const [name, setName] = useState('')
  const [corporationName, setCorporationName] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const addProfile = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    try {
      const id = parsePositiveInteger(characterId, 'Character ID')
      onChange(upsertCharacterProfile(registry, {
        characterId: id,
        name,
        corporationName: corporationName || null
      }, now()))
      setCharacterId('')
      setName('')
      setCorporationName('')
      setMessage('Profile added. OAuth tokens are not saved here.')
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const runRemote = async (
    action: string,
    operation: () => Promise<EveMultiAccountStatus>,
    successMessage: string
  ): Promise<void> => {
    if (busyAction) return
    setBusyAction(action)
    setMessage(null)
    try {
      onAccountsChange(await operation())
      setMessage(successMessage)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusyAction(null)
    }
  }

  const connectCharacter = async (): Promise<void> => {
    if (api) {
      await runRemote('connect', () => api.connectCharacter(), 'Character connected through EVE SSO.')
      return
    }
    try {
      await onRequestConnect?.()
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const cancelCharacterConnect = async (): Promise<void> => {
    if (!api || busyAction !== 'connect') return
    try {
      await api.cancelAccountConnect()
      setMessage('Sign-in canceled. You can open EVE SSO again now.')
    } catch (error) {
      setMessage(`Could not cancel sign-in: ${errorMessage(error)}`)
    }
  }

  return (
    <div id="pro-panel-characters" role="tabpanel" className="pro-panel pro-character-panel">
      <div className="pro-panel-heading">
        <div>
          <p className="eyebrow">Multi-character</p>
          <h2>Pilot profiles</h2>
          <p>
            {accountsStatus?.sessionOnly
              ? 'On macOS, SSO sessions last until Fly Safe closes and do not prompt for Keychain.'
              : 'Safely switch public context. Sessions remain in system storage.'}
          </p>
        </div>
        {api || onRequestConnect ? (
          <button
            className="primary-button"
            type="button"
            disabled={busyAction !== null && busyAction !== 'connect'}
            onClick={() => void (
              busyAction === 'connect' ? cancelCharacterConnect() : connectCharacter()
            )}
          >
            {busyAction === 'connect' ? 'Cancel sign-in' : 'Add through EVE SSO'}
          </button>
        ) : null}
      </div>

      <div className="pro-character-layout">
        {api ? (
          <section className="pro-form-card">
            <strong>EVE SSO registry</strong>
            <p>
              {accountsStatus?.sessionOnly
                ? 'The refresh token stays only in process memory and is removed when you exit.'
                : 'Each character has a separate refresh token encrypted through system storage.'}
            </p>
            <span>Connected: <b>{accountsStatus?.characters.length ?? 0}</b> / {accountsStatus?.maxCharacters ?? '—'}</span>
            <span>Legacy-token migration: <b>{accountsStatus?.legacyMigration ?? 'checking'}</b></span>
            {(message ?? remoteMessage) ? (
              <p className="pro-inline-message" role="status">{message ?? remoteMessage}</p>
            ) : null}
          </section>
        ) : (
          <form className="pro-form-card" onSubmit={addProfile}>
            <strong>Local profile</strong>
            <p>Fallback for testing the UI without an Electron main process.</p>
            <label>
              <span>Character ID</span>
              <input value={characterId} inputMode="numeric" onChange={(event) => setCharacterId(event.target.value)} placeholder="21122560144" />
            </label>
            <label>
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Capsuleer Name" />
            </label>
            <label>
              <span>Corporation</span>
              <input value={corporationName} onChange={(event) => setCorporationName(event.target.value)} placeholder="Optional" />
            </label>
            <button className="secondary-button" type="submit">Add profile</button>
            {message ? <p className="pro-inline-message" role="status">{message}</p> : null}
          </form>
        )}

        <div className="pro-character-list" aria-label="Character profiles">
          {registry.profiles.length === 0 ? (
            <div className="pro-empty-state">
              <strong>No characters added</strong>
              <p>{api
                ? 'Connect your first additional character through EVE SSO.'
                : 'Add a local profile to test the workspace.'}</p>
            </div>
          ) : registry.profiles.map((profile) => {
            const selected = registry.activeCharacterId === profile.characterId
            const access = resolveCharacterAccess(registry, profile.characterId, [], now())
            const remote = accountsStatus?.characters.find(
              (character) => character.characterId === profile.characterId
            ) ?? null
            const stateText = remote
              ? remote.connected
                ? 'SSO session active'
                : remote.credentialStored
                  ? 'Token saved; it will restore when selected'
                  : 'SSO disconnected'
              : access.state === 'ready'
                ? 'SSO session ready'
                : 'Profile without an SSO session'
            return (
              <article key={profile.characterId} className={selected ? 'selected' : ''}>
                <div className="pro-avatar" aria-hidden="true">{profile.name.slice(0, 2).toUpperCase()}</div>
                <div className="pro-character-copy">
                  <strong>{profile.name}</strong>
                  <span>{profile.corporationName ?? 'Corporation not specified'}</span>
                  <small>{stateText}</small>
                  {remote?.error ? <small className="pro-danger-button">{remote.error}</small> : null}
                </div>
                <div className="pro-character-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={selected || busyAction !== null || Boolean(
                      api && !remote?.credentialStored && !remote?.connected
                    )}
                    onClick={() => {
                      if (api) {
                        void runRemote(
                          `select:${profile.characterId}`,
                          () => api.selectCharacter(profile.characterId),
                          `${profile.name} selected.`
                        )
                      } else {
                        onChange(selectActiveCharacter(registry, profile.characterId, now()))
                      }
                    }}
                  >
                    {busyAction === `select:${profile.characterId}`
                      ? 'Signing in…'
                      : selected ? 'Active' : 'Select'}
                  </button>
                  {api && remote?.credentialStored ? (
                    <button
                      type="button"
                      className="text-button"
                      disabled={busyAction !== null}
                      onClick={() => void runRemote(
                        `disconnect:${profile.characterId}`,
                        () => api.disconnectCharacter(profile.characterId),
                        `${profile.name}: SSO token removed.`
                      )}
                    >
                      Disconnect SSO
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="text-button pro-danger-button"
                    aria-label={`Remove profile ${profile.name}`}
                    disabled={busyAction !== null}
                    onClick={() => {
                      if (api) {
                        void runRemote(
                          `remove:${profile.characterId}`,
                          () => api.removeCharacter(profile.characterId),
                          `${profile.name} removed.`
                        )
                      } else {
                        onChange(removeCharacterProfile(registry, profile.characterId, now()))
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      </div>

      <p className="pro-security-note">
        localStorage contains only names, public IDs, and radar settings. OAuth tokens,
        credential IDs, and shared fleet data are excluded.
      </p>
    </div>
  )
}

const STABLE_WORMHOLE_TEXT = `This wormhole has not yet begun to decay, and probably won't for at least another day.
This wormhole has not yet had its stability significantly disrupted by ships passing through it.`

function WormholeChainPanel({
  api,
  currentSystem,
  now
}: {
  api: EveLocalIntelApi | null
  currentSystem: { solarSystemId: number; name: string } | null
  now: () => string
}): React.JSX.Element {
  const [chain, setChain] = useState<WormholeChain>(() => (
    api ? { systems: [], signatures: [], connections: [] } : demoWormholeChain(now())
  ))
  const [currentSystemId, setCurrentSystemId] = useState(api ? '' : 'current')
  const [fromSystemId, setFromSystemId] = useState(api ? '' : 'current')
  const [destinationName, setDestinationName] = useState('J-new')
  const [wormholeCode, setWormholeCode] = useState('K162')
  const [statusText, setStatusText] = useState(STABLE_WORMHOLE_TEXT)
  const [destinationHome, setDestinationHome] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(Boolean(api))

  useEffect(() => {
    if (!api) return
    let active = true
    void (async () => {
      setBusy(true)
      setMessage(null)
      try {
        let next = await api.getWormholeChain()
        if (
          currentSystem &&
          !next.systems.some((system) => system.solarSystemId === currentSystem.solarSystemId)
        ) {
          await api.upsertWormholeSystem({
            solarSystemId: currentSystem.solarSystemId,
            name: currentSystem.name,
            seenAt: now()
          })
          next = await api.getWormholeChain()
        }
        if (!active) return
        setChain(next)
        const preferred = currentSystem
          ? next.systems.find((system) => system.solarSystemId === currentSystem.solarSystemId)
          : null
        const fallback = preferred?.id ?? next.systems[0]?.id ?? ''
        setCurrentSystemId((value) => next.systems.some((system) => system.id === value)
          ? value
          : fallback)
        setFromSystemId((value) => next.systems.some((system) => system.id === value)
          ? value
          : fallback)
      } catch (error) {
        if (active) setMessage(errorMessage(error))
      } finally {
        if (active) setBusy(false)
      }
    })()
    return () => { active = false }
  }, [api, currentSystem?.name, currentSystem?.solarSystemId, now])
  const status = useMemo(() => parseWormholeStatusText(statusText), [statusText])
  const route = useMemo(
    () => currentSystemId ? findWormholeRouteHome(chain, currentSystemId, now()) : null,
    [chain, currentSystemId, now]
  )
  const names = useMemo(
    () => new Map(chain.systems.map((system) => [system.id, system.name])),
    [chain.systems]
  )

  const addConnection = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (busy) return
    const name = destinationName.normalize('NFKC').trim().replace(/\s+/g, ' ')
    if (!name) {
      setMessage('Enter the destination system name.')
      return
    }
    if (!chain.systems.some((system) => system.id === fromSystemId)) {
      setMessage('First open Fly Safe in an EVE system or select an origin system.')
      return
    }
    const timestamp = now()
    const nodeId = uniqueNodeId(chain, name)
    const connectionId = `wh-${mutationId()}`
    const node: WormholeSystemNode = {
      id: nodeId,
      solarSystemId: null,
      name,
      isHome: destinationHome,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp
    }
    const connection: WormholeConnection = {
      id: connectionId,
      fromSystemNodeId: fromSystemId,
      toSystemNodeId: nodeId,
      fromSignatureId: null,
      reverseSignatureId: null,
      wormholeCode: wormholeCode.trim().toUpperCase() || null,
      massStatus: status.massStatus,
      lifeStatus: status.lifeStatus,
      discoveredAt: timestamp,
      updatedAt: timestamp,
      expiresAt: null
    }
    setBusy(true)
    setMessage(null)
    try {
      if (api) {
        const savedNode = await api.upsertWormholeSystem({
          id: node.id,
          solarSystemId: node.solarSystemId,
          name: node.name,
          isHome: node.isHome,
          seenAt: timestamp
        })
        await api.upsertWormholeConnection({
          ...connection,
          toSystemNodeId: savedNode.id
        })
        const next = await api.getWormholeChain()
        setChain(next)
      } else {
        setChain((current) => ({
          systems: [...current.systems, node],
          signatures: current.signatures,
          connections: [...current.connections, connection]
        }))
      }
      setDestinationName('J-new')
      setDestinationHome(false)
      setMessage(`${name} saved; status ${status.massStatus} / ${status.lifeStatus}.`)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div id="pro-panel-wormholes" role="tabpanel" className="pro-panel pro-wormhole-panel">
      <div className="pro-panel-heading">
        <div>
          <p className="eyebrow">Wormhole Chain Mapper</p>
          <h2>Chain and safe way home</h2>
          <p>Parses mass/EOL descriptions and chooses a lower-risk route, not just the shortest one.</p>
        </div>
        <span className={`pro-route-risk ${route?.risk ?? 'unknown'}`}>
          {route ? `${route.jumps} jumps · ${route.risk}` : 'No route found'}
        </span>
      </div>

      <div className="pro-wormhole-layout">
        <section className="pro-chain-map" aria-label="Wormhole chain map">
          <div className="pro-chain-route">
            <span>Route home</span>
            <strong>{route
              ? route.systemNodeIds.map((id) => names.get(id) ?? id).join(' → ')
              : 'No available connection'}</strong>
            {route?.warnings.map((warning) => <small key={warning}>{warning}</small>)}
          </div>
          <div className="pro-node-grid">
            {chain.systems.map((system) => (
              <button
                type="button"
                key={system.id}
                className={currentSystemId === system.id ? 'selected' : ''}
                onClick={() => {
                  setCurrentSystemId(system.id)
                  setFromSystemId(system.id)
                }}
              >
                <span>{system.isHome ? 'HOME' : 'SYSTEM'}</span>
                <strong>{system.name}</strong>
                <small>{currentSystemId === system.id ? 'current' : 'calculate from here'}</small>
              </button>
            ))}
          </div>
          <div className="pro-connection-list">
            {chain.connections.map((connection) => (
              <div key={connection.id}>
                <span>{names.get(connection.fromSystemNodeId)} → {names.get(connection.toSystemNodeId)}</span>
                <b>{connection.wormholeCode ?? '???'}</b>
                <small>{connection.massStatus} · {connection.lifeStatus}</small>
              </div>
            ))}
          </div>
        </section>

        <form className="pro-form-card" onSubmit={(event) => void addConnection(event)}>
          <strong>Add connection</strong>
          <label><span>From system</span><select value={fromSystemId} onChange={(event) => setFromSystemId(event.target.value)}>{chain.systems.map((system) => <option key={system.id} value={system.id}>{system.name}</option>)}</select></label>
          <label><span>New system</span><input value={destinationName} onChange={(event) => setDestinationName(event.target.value)} /></label>
          <label><span>Wormhole code</span><input value={wormholeCode} onChange={(event) => setWormholeCode(event.target.value)} /></label>
          <label><span>Show Info text</span><textarea value={statusText} onChange={(event) => setStatusText(event.target.value)} /></label>
          <div className="pro-status-preview"><span>Mass: <b>{status.massStatus}</b></span><span>Life: <b>{status.lifeStatus}</b></span></div>
          <label className="pro-checkbox"><input type="checkbox" checked={destinationHome} onChange={(event) => setDestinationHome(event.target.checked)} /><span>Mark as HOME</span></label>
          <button className="secondary-button" type="submit" disabled={busy || chain.systems.length === 0}>
            {busy ? 'Saving…' : 'Add to chain'}
          </button>
          {message ? <p className="pro-inline-message" role="status">{message}</p> : null}
        </form>
      </div>
      <p className="pro-security-note">
        The chain is stored locally in the SQLite main process; OAuth tokens never enter the map.
        Copied Probe Scanner signatures are added automatically for the current system.
      </p>
    </div>
  )
}

const DEFAULT_HUNTER_ROWS = [
  '2026-08-22T20:10:00Z | 31000001 | J100001 | 101 | Target One',
  '2026-08-23T20:30:00Z | 31000001 | J100001 | 101 | Target One',
  '2026-08-24T20:15:00Z | 31000002 | J100002 | 101 | Target One',
  '2026-08-24T21:15:00Z | 31000002 | J100002 | 202 | Second Target',
  '2026-08-25T20:15:00Z | 31000001 | J100001 | 101 | Target One'
].join('\n')

function HunterPlannerPanel({ api }: { api: EveLocalIntelApi | null }): React.JSX.Element {
  const [rows, setRows] = useState(DEFAULT_HUNTER_ROWS)
  const [timezoneOffset, setTimezoneOffset] = useState('300')
  const [bucketMinutes, setBucketMinutes] = useState('60')
  const localBuilt = useMemo(
    () => buildHunterDemo(rows, timezoneOffset, bucketMinutes),
    [bucketMinutes, rows, timezoneOffset]
  )
  const [remotePlan, setRemotePlan] = useState<HunterPlan | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(api))

  useEffect(() => {
    if (!api) return
    let active = true
    const timer = window.setTimeout(() => {
      void (async () => {
        setLoading(true)
        setRemoteError(null)
        try {
          const plan = await api.getHunterPlan({
            timezoneOffsetMinutes: parseBoundedInteger(
              timezoneOffset,
              'UTC offset',
              -14 * 60,
              14 * 60
            ),
            activityBucketMinutes: parseBoundedInteger(
              bucketMinutes,
              'Deduplication window',
              5,
              24 * 60
            )
          })
          if (active) setRemotePlan(plan)
        } catch (error) {
          if (active) {
            setRemotePlan(null)
            setRemoteError(errorMessage(error))
          }
        } finally {
          if (active) setLoading(false)
        }
      })()
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, bucketMinutes, timezoneOffset])

  const built = api
    ? { plan: remotePlan, error: remoteError }
    : localBuilt
  const maximumHeat = built.plan
    ? Math.max(1, ...built.plan.heatmap.map((cell) => cell.encounters))
    : 1

  return (
    <div id="pro-panel-hunter" role="tabpanel" className="pro-panel pro-hunter-panel">
      <div className="pro-panel-heading">
        <div>
          <p className="eyebrow">Hunter Planner</p>
          <h2>Target activity windows</h2>
          <p>Aggregates the local encounter journal by time, systems, and unique pilots.</p>
        </div>
        <span className="pro-demo-badge">{loading ? 'Calculating…' : 'Local SQLite analytics'}</span>
      </div>

      <div className="pro-hunter-controls">
        <label><span>UTC offset, minutes</span><input inputMode="numeric" value={timezoneOffset} onChange={(event) => setTimezoneOffset(event.target.value)} /></label>
        <label><span>Deduplication window, minutes</span><input inputMode="numeric" value={bucketMinutes} onChange={(event) => setBucketMinutes(event.target.value)} /></label>
      </div>
      {!api ? (
        <label className="pro-hunter-input">
          <span>Snapshots: ISO time | system ID | system | character ID | pilot</span>
          <textarea value={rows} onChange={(event) => setRows(event.target.value)} />
        </label>
      ) : null}

      {built.error ? (
        <div className="pro-empty-state error"><strong>Check encounter rows</strong><p>{built.error}</p></div>
      ) : built.plan ? (
        <div className="pro-hunter-results">
          <div className="pro-hunter-kpis">
            <article><span>Snapshots</span><strong>{built.plan.sourceSnapshotCount}</strong></article>
            <article><span>Encounters</span><strong>{built.plan.encounters}</strong></article>
            <article><span>Targets</span><strong>{built.plan.targets.length}</strong></article>
            <article><span>Systems</span><strong>{built.plan.systems.length}</strong></article>
          </div>
          <div className="pro-hunter-grid">
            <section>
              <strong>Heatmap · 7 × 24</strong>
              <div className="pro-heatmap" aria-label="Activity heatmap by day and hour">
                {built.plan.heatmap.map((cell) => (
                  <span
                    key={`${cell.weekday}-${cell.hour}`}
                    className={`level-${Math.ceil(cell.encounters / maximumHeat * 4)}`}
                    title={`${weekdayName(cell.weekday)}, ${cell.hour}:00 — ${cell.encounters}`}
                    aria-label={`${weekdayName(cell.weekday)} ${cell.hour}:00: ${cell.encounters} encounters`}
                  />
                ))}
              </div>
              <div className="pro-heatmap-legend"><span>Sun</span><span>Each row: 00–23</span><span>Sat</span></div>
            </section>
            <section>
              <strong>Top targets</strong>
              <div className="pro-target-list">
                {built.plan.targets.slice(0, 6).map((target) => (
                  <article key={target.key}>
                    <div><strong>{target.name}</strong><span>{target.systems[0]?.name ?? 'System unknown'}</span></div>
                    <b>{target.confidence}</b>
                    <small>{target.encounters} encounters · {target.activeHours[0]?.hour ?? '—'}:00</small>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </div>
      ) : null}
      <p className="pro-security-note">
        The planner reads the full local journal retention directly in the main process and returns
        only aggregates to the renderer. Encounter rows are never sent over the network.
      </p>
    </div>
  )
}

function DoctrineMatcherPanel({
  api,
  now
}: {
  api: EveLocalIntelApi | null
  now: () => string
}): React.JSX.Element {
  const [name, setName] = useState('Small armor fleet')
  const [role, setRole] = useState<DscanShipRole>('logistics')
  const [roleMinimum, setRoleMinimum] = useState('2')
  const [roleTarget, setRoleTarget] = useState('2')
  const [roleMaximum, setRoleMaximum] = useState('3')
  const [hull, setHull] = useState('Guardian')
  const [hullMinimum, setHullMinimum] = useState('2')
  const [hullTarget, setHullTarget] = useState('2')
  const [hullMaximum, setHullMaximum] = useState('2')
  const [dscan, setDscan] = useState('Guardian\nSabre\nSabre\nDrake')
  const [templates, setTemplates] = useState<DoctrineTemplate[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [liveResult, setLiveResult] = useState<DoctrineMatchResult | null>(null)
  const [storeMessage, setStoreMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(Boolean(api))
  const built = useMemo(() => buildDoctrineDemo({
    name,
    role,
    roleMinimum,
    roleTarget,
    roleMaximum,
    hull,
    hullMinimum,
    hullTarget,
    hullMaximum,
    dscan
  }, now()), [
    dscan,
    hull,
    hullMaximum,
    hullMinimum,
    hullTarget,
    name,
    now,
    role,
    roleMaximum,
    roleMinimum,
    roleTarget
  ])

  useEffect(() => {
    if (!api) return
    let active = true
    setBusy(true)
    void api.listDoctrineTemplates().then((next) => {
      if (!active) return
      setTemplates(next)
      setSelectedTemplateId((current) => current || next[0]?.id || '')
    }).catch((error) => {
      if (active) setStoreMessage(errorMessage(error))
    }).finally(() => {
      if (active) setBusy(false)
    })
    return () => { active = false }
  }, [api])

  useEffect(() => {
    setLiveResult(null)
  }, [dscan, hull, hullMaximum, hullMinimum, hullTarget, name, role, roleMaximum, roleMinimum, roleTarget])

  const loadTemplate = (id: string): void => {
    setSelectedTemplateId(id)
    const template = templates.find((entry) => entry.id === id)
    if (!template) return
    const roleEntry = template.roles[0]
    const hullEntry = template.hulls[0]
    setName(template.name)
    if (roleEntry) {
      setRole(roleEntry.role)
      setRoleMinimum(String(roleEntry.minimum))
      setRoleTarget(String(roleEntry.target))
      setRoleMaximum(roleEntry.maximum === null ? '' : String(roleEntry.maximum))
    }
    if (hullEntry) {
      setHull(hullEntry.typeName)
      setHullMinimum(String(hullEntry.minimum))
      setHullTarget(String(hullEntry.target))
      setHullMaximum(hullEntry.maximum === null ? '' : String(hullEntry.maximum))
    }
  }

  const currentInput = (id?: string): DoctrineTemplateInput => ({
    ...(id ? { id } : {}),
    name,
    roles: [{
      role,
      minimum: parseNonNegativeInteger(roleMinimum, 'Role minimum'),
      target: parseNonNegativeInteger(roleTarget, 'Role target'),
      maximum: parseOptionalNonNegativeInteger(roleMaximum, 'Role maximum')
    }],
    hulls: hull.trim() ? [{
      typeName: hull,
      minimum: parseNonNegativeInteger(hullMinimum, 'Hull minimum'),
      target: parseNonNegativeInteger(hullTarget, 'Hull target'),
      maximum: parseOptionalNonNegativeInteger(hullMaximum, 'Hull maximum')
    }] : []
  })

  const saveTemplate = async (): Promise<DoctrineTemplate | null> => {
    if (!api || busy) return null
    setBusy(true)
    setStoreMessage(null)
    try {
      const saved = await api.saveDoctrineTemplate(
        currentInput(selectedTemplateId || undefined)
      )
      const next = await api.listDoctrineTemplates()
      setTemplates(next)
      setSelectedTemplateId(saved.id)
      setStoreMessage('Doctrine saved in local SQLite.')
      return saved
    } catch (error) {
      setStoreMessage(errorMessage(error))
      return null
    } finally {
      setBusy(false)
    }
  }

  const runMatch = async (): Promise<void> => {
    if (!api || busy) return
    const template = selectedTemplateId
      ? templates.find((entry) => entry.id === selectedTemplateId) ?? null
      : await saveTemplate()
    if (!template) return
    setBusy(true)
    setStoreMessage(null)
    try {
      setLiveResult(await api.matchDoctrine(template.id, dscan))
    } catch (error) {
      setStoreMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const deleteTemplate = async (): Promise<void> => {
    if (!api || !selectedTemplateId || busy) return
    setBusy(true)
    setStoreMessage(null)
    try {
      await api.deleteDoctrineTemplate(selectedTemplateId)
      const next = await api.listDoctrineTemplates()
      setTemplates(next)
      setSelectedTemplateId(next[0]?.id ?? '')
      setLiveResult(null)
      setStoreMessage('Doctrine removed.')
    } catch (error) {
      setStoreMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const effectiveResult = api ? liveResult : built.result

  return (
    <div id="pro-panel-doctrine" role="tabpanel" className="pro-panel pro-doctrine-panel">
      <div className="pro-panel-heading">
        <div>
          <p className="eyebrow">D-scan Doctrine Matcher</p>
          <h2>Compare composition to doctrine</h2>
          <p>Shows shortages, excess, and matches for roles and exact hulls.</p>
        </div>
        {effectiveResult ? <span className={`pro-doctrine-score ${effectiveResult.status}`}>{effectiveResult.score}% · {effectiveResult.status}</span> : null}
      </div>

      <div className="pro-doctrine-layout">
        <section className="pro-doctrine-form">
          {api ? (
            <label className="wide">
              <span>Saved doctrines</span>
              <select value={selectedTemplateId} onChange={(event) => loadTemplate(event.target.value)}>
                <option value="">New doctrine</option>
                {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
              </select>
            </label>
          ) : null}
          <label className="wide"><span>Doctrine</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value as DscanShipRole)}>{DOCTRINE_ROLES.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select></label>
          <label><span>Min</span><input inputMode="numeric" value={roleMinimum} onChange={(event) => setRoleMinimum(event.target.value)} /></label>
          <label><span>Target</span><input inputMode="numeric" value={roleTarget} onChange={(event) => setRoleTarget(event.target.value)} /></label>
          <label><span>Max</span><input inputMode="numeric" value={roleMaximum} onChange={(event) => setRoleMaximum(event.target.value)} /></label>
          <label><span>Hull</span><input value={hull} onChange={(event) => setHull(event.target.value)} /></label>
          <label><span>Min</span><input inputMode="numeric" value={hullMinimum} onChange={(event) => setHullMinimum(event.target.value)} /></label>
          <label><span>Target</span><input inputMode="numeric" value={hullTarget} onChange={(event) => setHullTarget(event.target.value)} /></label>
          <label><span>Max</span><input inputMode="numeric" value={hullMaximum} onChange={(event) => setHullMaximum(event.target.value)} /></label>
          <label className="wide"><span>D-scan: one hull per row; “Guardian x2” is allowed</span><textarea value={dscan} onChange={(event) => setDscan(event.target.value)} /></label>
          {api ? (
            <div className="wide pro-character-actions">
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void saveTemplate()}>{busy ? 'Saving…' : 'Save'}</button>
              <button className="primary-button" type="button" disabled={busy} onClick={() => void runMatch()}>Compare D-scan</button>
              <button className="text-button pro-danger-button" type="button" disabled={busy || !selectedTemplateId} onClick={() => void deleteTemplate()}>Remove</button>
            </div>
          ) : null}
          {storeMessage ? <p className="wide pro-inline-message" role="status">{storeMessage}</p> : null}
        </section>

        <section className="pro-doctrine-result" aria-live="polite">
          {built.error ? (
            <div className="pro-empty-state error"><strong>Template is invalid</strong><p>{built.error}</p></div>
          ) : effectiveResult ? (
            <>
              <div className="pro-doctrine-kpis"><span>On D-scan <b>{effectiveResult.observedTotal}</b></span><span>Unclassified <b>{effectiveResult.unclassifiedCount}</b></span></div>
              <div className="pro-comparison-list">
                {[...effectiveResult.roleComparisons, ...effectiveResult.hullComparisons].map((comparison) => (
                  <article key={'role' in comparison ? `role-${comparison.role}` : `hull-${comparison.normalizedTypeName}`} className={comparison.status}>
                    <div><strong>{'role' in comparison ? comparison.role : comparison.typeName}</strong><small>{comparison.explanation}</small></div>
                    <b>{comparison.actual}/{comparison.target}</b>
                  </article>
                ))}
              </div>
              {effectiveResult.unrequestedRoles.length > 0 ? <p>Outside template: {effectiveResult.unrequestedRoles.map((entry) => `${entry.role} ×${entry.count}`).join(', ')}</p> : null}
            </>
          ) : api ? <div className="pro-empty-state"><strong>Ready to compare</strong><p>Save a doctrine and paste a fresh D-scan.</p></div> : null}
        </section>
      </div>
      <p className="pro-security-note">Doctrines are stored in the SQLite main process. Pasted D-scan data is not saved and is reparsed in main before comparison.</p>
    </div>
  )
}

function MarketRadarPanel({
  draft,
  result,
  onChange,
  api
}: {
  draft: MarketRadarDraft
  result: { radar: MarketOpportunityRadar | null; error: string | null }
  onChange: (draft: MarketRadarDraft) => void
  api: EveLocalIntelApi | null
}): React.JSX.Element {
  const [liveRadar, setLiveRadar] = useState<MarketOpportunityRadar | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const update = <Key extends keyof MarketRadarDraft>(
    key: Key,
    value: MarketRadarDraft[Key]
  ): void => {
    if (api) {
      setLiveRadar(null)
      setLiveError(null)
    }
    onChange({ ...draft, [key]: value })
  }
  const effectiveResult = api
    ? { radar: liveRadar, error: liveError }
    : result
  const opportunity = effectiveResult.radar?.opportunities[0] ?? null

  const evaluateLive = async (): Promise<void> => {
    if (!api || loading) return
    setLoading(true)
    setLiveError(null)
    try {
      setLiveRadar(await api.evaluateMarketOpportunity({
        typeId: parsePositiveInteger(draft.typeId, 'Type ID'),
        typeName: draft.typeName,
        quantity: parsePositiveInteger(draft.quantity, 'Quantity'),
        originHubId: draft.originHubId,
        destinationHubId: draft.destinationHubId,
        unitVolumeM3: parsePositiveNumber(draft.unitVolumeM3, 'Unit volume'),
        feeRate: parseRange(draft.feePercent, 'Fees', 0, 100) / 100,
        haulingCostIsk: parseNonNegativeNumber(draft.haulingCostIsk, 'Hauling'),
        riskAversion: parseRange(draft.riskAversionPercent, 'Risk adjustment', 0, 100) / 100
      }))
    } catch (error) {
      setLiveRadar(null)
      setLiveError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div id="pro-panel-radar" role="tabpanel" className="pro-panel pro-radar-panel">
      <div className="pro-panel-heading">
        <div>
          <p className="eyebrow">Market Opportunity Radar</p>
          <h2>Risk-adjusted margin</h2>
          <p>Compares fillable order books, fees, hauling, and historical route risk.</p>
        </div>
        <span className="pro-demo-badge">{api ? 'ESI depth + Route Intel' : 'Manual input'}</span>
      </div>

      <div className="pro-radar-layout">
        <div className="pro-radar-form">
          <label className="wide"><span>Item</span><input value={draft.typeName} onChange={(event) => update('typeName', event.target.value)} /></label>
          <label><span>Type ID</span><input inputMode="numeric" value={draft.typeId} onChange={(event) => update('typeId', event.target.value)} /></label>
          <label><span>Quantity</span><input inputMode="numeric" value={draft.quantity} onChange={(event) => update('quantity', event.target.value)} /></label>
          <label><span>Buy in</span><select value={draft.originHubId} onChange={(event) => update('originHubId', event.target.value as MarketHubId)}>{MARKET_HUBS.map((hub) => <option key={hub.id} value={hub.id}>{hub.name}</option>)}</select></label>
          <label><span>Sell in</span><select value={draft.destinationHubId} onChange={(event) => update('destinationHubId', event.target.value as MarketHubId)}>{MARKET_HUBS.map((hub) => <option key={hub.id} value={hub.id}>{hub.name}</option>)}</select></label>
          {!api ? <label><span>Purchase, ISK</span><input inputMode="decimal" value={draft.originTotalIsk} onChange={(event) => update('originTotalIsk', event.target.value)} /></label> : null}
          {!api ? <label><span>Revenue, ISK</span><input inputMode="decimal" value={draft.destinationTotalIsk} onChange={(event) => update('destinationTotalIsk', event.target.value)} /></label> : null}
          <label><span>Unit volume, m³</span><input inputMode="decimal" value={draft.unitVolumeM3} onChange={(event) => update('unitVolumeM3', event.target.value)} /></label>
          {!api ? <label><span>Jumps</span><input inputMode="numeric" value={draft.jumps} onChange={(event) => update('jumps', event.target.value)} /></label> : null}
          {!api ? <label><span>Average risk, 0–100</span><input inputMode="decimal" value={draft.averageRiskScore} onChange={(event) => update('averageRiskScore', event.target.value)} /></label> : null}
          {!api ? <label><span>Max. risk, 0–100</span><input inputMode="decimal" value={draft.maximumRiskScore} onChange={(event) => update('maximumRiskScore', event.target.value)} /></label> : null}
          {!api ? <label><span>Camp systems</span><input inputMode="numeric" value={draft.campPatternSystems} onChange={(event) => update('campPatternSystems', event.target.value)} /></label> : null}
          <label><span>Fees, %</span><input inputMode="decimal" value={draft.feePercent} onChange={(event) => update('feePercent', event.target.value)} /></label>
          <label><span>Hauling, ISK</span><input inputMode="decimal" value={draft.haulingCostIsk} onChange={(event) => update('haulingCostIsk', event.target.value)} /></label>
          <label className="wide pro-risk-range">
            <span>Risk adjustment: {draft.riskAversionPercent}%</span>
            <input type="range" min="0" max="100" value={draft.riskAversionPercent} onChange={(event) => update('riskAversionPercent', event.target.value)} />
          </label>
          {api ? (
            <button className="primary-button wide" type="button" disabled={loading} onClick={() => void evaluateLive()}>
              {loading ? 'Reading ESI and route…' : 'Find opportunity'}
            </button>
          ) : null}
        </div>

        <div className="pro-radar-result" aria-live="polite">
          {effectiveResult.error ? (
            <div className="pro-empty-state error"><strong>Check input</strong><p>{effectiveResult.error}</p></div>
          ) : opportunity ? (
            <>
              <div className="pro-radar-route">
                <span>{getMarketHub(opportunity.originHubId).name}</span>
                <b aria-hidden="true">→</b>
                <span>{getMarketHub(opportunity.destinationHubId).name}</span>
              </div>
              <strong className={opportunity.riskAdjustedProfitIsk >= 0 ? 'profit' : 'loss'}>
                {formatIsk(opportunity.riskAdjustedProfitIsk)}
              </strong>
              <span className="pro-result-caption">after risk</span>
              <dl>
                <div><dt>Net profit</dt><dd>{formatIsk(opportunity.hauling.netProfitIsk)}</dd></div>
                <div><dt>Margin</dt><dd>{formatPercent(opportunity.netMarginPercent)}</dd></div>
                <div><dt>Profit / m³</dt><dd>{formatIsk(opportunity.hauling.netProfitPerM3)}</dd></div>
                <div><dt>Route risk</dt><dd>{opportunity.risk.index}/100</dd></div>
                <div><dt>Risk penalty</dt><dd>{formatIsk(opportunity.risk.penaltyIsk)}</dd></div>
                <div><dt>Fees + haul</dt><dd>{formatIsk(opportunity.hauling.totalCostsIsk)}</dd></div>
              </dl>
              <p>Historical heuristic. Not a live-camp forecast or a guarantee of fill.</p>
            </>
          ) : (
            <div className="pro-empty-state"><strong>{api ? 'Run the calculation' : 'Opportunity filtered out'}</strong><p>{effectiveResult.radar?.skipped[0]?.detail ?? (api ? 'Prices and risk will load from ESI and Route Intel.' : 'No data to calculate.')}</p></div>
          )}
        </div>
      </div>
    </div>
  )
}

function SharedFleetPanel({
  activeCharacter,
  workspace,
  now,
  onChange,
  api
}: {
  activeCharacter: CharacterProfile | null
  workspace: SharedWorkspaceSnapshot | null
  now: () => string
  onChange: (workspace: SharedWorkspaceSnapshot | null) => void
  api: EveLocalIntelApi | null
}): React.JSX.Element {
  const [workspaceName, setWorkspaceName] = useState('Home Defense')
  const [workspaceSummaries, setWorkspaceSummaries] = useState<SharedWorkspaceSummary[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspace?.workspaceId ?? '')
  const [sharePresence, setSharePresence] = useState(false)
  const [memberId, setMemberId] = useState('')
  const [memberName, setMemberName] = useState('')
  const [memberRole, setMemberRole] = useState<Exclude<SharedWorkspaceRole, 'owner'>>('viewer')
  const [watchId, setWatchId] = useState('')
  const [watchName, setWatchName] = useState('')
  const [watchSeverity, setWatchSeverity] = useState<'watch' | 'danger' | 'critical'>('danger')
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId)
  const latestWorkspaceRef = useRef(workspace)
  const refreshRequestRef = useRef(0)
  const workspaceCharacterIdRef = useRef(activeCharacter?.characterId ?? null)

  useEffect(() => {
    if (workspace) {
      latestWorkspaceRef.current = preferNewestSharedWorkspaceSnapshot(
        latestWorkspaceRef.current,
        workspace
      )
    }
    if (workspace?.workspaceId && !selectedWorkspaceIdRef.current) {
      selectedWorkspaceIdRef.current = workspace.workspaceId
      setSelectedWorkspaceId(workspace.workspaceId)
    }
  }, [workspace])

  const chooseWorkspace = useCallback((workspaceId: string): void => {
    selectedWorkspaceIdRef.current = workspaceId
    setSelectedWorkspaceId(workspaceId)
  }, [])

  const clearWorkspace = useCallback((): void => {
    refreshRequestRef.current += 1
    selectedWorkspaceIdRef.current = ''
    latestWorkspaceRef.current = null
    setSelectedWorkspaceId('')
    setRefreshing(false)
    onChange(null)
  }, [onChange])

  const installWorkspace = useCallback((incoming: SharedWorkspaceSnapshot): void => {
    if (selectedWorkspaceIdRef.current && selectedWorkspaceIdRef.current !== incoming.workspaceId) {
      return
    }
    chooseWorkspace(incoming.workspaceId)
    const latest = preferNewestSharedWorkspaceSnapshot(latestWorkspaceRef.current, incoming)
    latestWorkspaceRef.current = latest
    onChange(latest)
  }, [chooseWorkspace, onChange])

  const refreshWorkspace = useCallback(async (workspaceId: string): Promise<SharedWorkspaceSnapshot> => {
    if (!api) throw new Error('Cloud transport unavailable')
    const request = ++refreshRequestRef.current
    setRefreshing(true)
    try {
      const incoming = await api.getSharedWorkspace(workspaceId)
      if (request === refreshRequestRef.current && selectedWorkspaceIdRef.current === workspaceId) {
        installWorkspace(incoming)
      }
      return incoming
    } finally {
      if (request === refreshRequestRef.current) setRefreshing(false)
    }
  }, [api, installWorkspace])

  const recoverWorkspaceAfterError = useCallback(async (
    workspaceId: string,
    error: unknown
  ): Promise<void> => {
    const originalMessage = errorMessage(error)
    if (!api || selectedWorkspaceIdRef.current !== workspaceId) {
      setMessage(originalMessage)
      return
    }
    try {
      await refreshWorkspace(workspaceId)
      setMessage(`${originalMessage} The latest room revision was loaded — repeat the action.`)
    } catch (refreshError) {
      setMessage(`${originalMessage} Could not refresh room: ${errorMessage(refreshError)}`)
    }
  }, [api, refreshWorkspace])

  useEffect(() => {
    if (!api) return
    if (!activeCharacter) {
      workspaceCharacterIdRef.current = null
      setWorkspaceSummaries([])
      clearWorkspace()
      return
    }
    if (workspaceCharacterIdRef.current !== activeCharacter.characterId) {
      workspaceCharacterIdRef.current = activeCharacter.characterId
      setWorkspaceSummaries([])
      clearWorkspace()
    }
    let active = true
    setBusy(true)
    setMessage(null)
    void api.listSharedWorkspaces().then(async (summaries) => {
      if (!active) return
      setWorkspaceSummaries(summaries)
      if (summaries.length === 0) {
        clearWorkspace()
        return
      }
      const previousId = selectedWorkspaceIdRef.current
      const selected = summaries.some((summary) => summary.workspaceId === previousId)
        ? previousId
        : summaries[0].workspaceId
      chooseWorkspace(selected)
      await refreshWorkspace(selected)
    }).catch((error) => {
      if (active) {
        setMessage(errorMessage(error))
      }
    }).finally(() => {
      if (active) setBusy(false)
    })
    return () => { active = false }
  }, [activeCharacter?.characterId, api, chooseWorkspace, clearWorkspace, refreshWorkspace])

  useEffect(() => {
    if (!api || !activeCharacter || !selectedWorkspaceId) return
    const interval = window.setInterval(() => {
      void refreshWorkspace(selectedWorkspaceId).catch((error) => {
        setMessage(`Room auto-refresh failed: ${errorMessage(error)}`)
      })
    }, SHARED_WORKSPACE_REFRESH_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [activeCharacter?.characterId, api, refreshWorkspace, selectedWorkspaceId])

  const currentMember = workspace && activeCharacter
    ? workspace.members.find((member) => member.characterId === activeCharacter.characterId) ?? null
    : null
  const currentConsent = currentMember && workspace &&
    currentMember.consent?.policyVersion === workspace.policyVersion
    ? currentMember.consent
    : null
  const canManageMembers = currentMember?.role === 'owner'
  const liveRecords = workspace?.records.filter((record) => record.deletedAt === null) ?? []

  const create = async (): Promise<void> => {
    if (!activeCharacter) {
      setMessage('First add and select a character.')
      return
    }
    setBusy(true)
    try {
      const created = api
        ? await api.createSharedWorkspace(workspaceName)
        : createSharedWorkspace({
            workspaceId: `local-${activeCharacter.characterId}`,
            name: workspaceName,
            policyVersion: 1,
            owner: {
              characterId: activeCharacter.characterId,
              characterName: activeCharacter.name
            }
          }, now())
      if (api) chooseWorkspace(created.workspaceId)
      installWorkspace(created)
      if (api) {
        setWorkspaceSummaries(await api.listSharedWorkspaces())
      }
      setMessage('Room created. Confirm the sharing scopes.')
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const acceptConsent = async (): Promise<void> => {
    if (!workspace || !activeCharacter) return
    setBusy(true)
    try {
      const scopes: SharedWorkspaceShareScope[] = sharePresence
        ? [...ALL_TEAM_SCOPES, 'local-presence']
        : ALL_TEAM_SCOPES
      const updated = api
        ? await api.acceptSharedWorkspaceConsent(
            workspace.workspaceId,
            workspace.policyVersion,
            scopes,
            workspace.revision
          )
        : acceptSharedWorkspaceConsent(workspace, {
            characterId: activeCharacter.characterId,
            policyVersion: workspace.policyVersion,
            scopes,
            expectedWorkspaceRevision: workspace.revision
          }, now())
      installWorkspace(updated)
      setMessage('Consent saved for the current policy version.')
    } catch (error) {
      await recoverWorkspaceAfterError(workspace.workspaceId, error)
    } finally {
      setBusy(false)
    }
  }

  const revokeConsent = async (): Promise<void> => {
    if (!workspace || !activeCharacter) return
    setBusy(true)
    try {
      const updated = api
        ? await api.revokeSharedWorkspaceConsent(workspace.workspaceId, workspace.revision)
        : revokeSharedWorkspaceConsent(
            workspace,
            activeCharacter.characterId,
            workspace.revision,
            now()
          )
      installWorkspace(updated)
      setMessage('Sharing stopped. Local data was not deleted.')
    } catch (error) {
      await recoverWorkspaceAfterError(workspace.workspaceId, error)
    } finally {
      setBusy(false)
    }
  }

  const invite = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!workspace || !activeCharacter) return
    setBusy(true)
    try {
      const characterId = parsePositiveInteger(memberId, 'Member ID')
      const updated = api
        ? await api.addSharedWorkspaceMember(
            workspace.workspaceId,
            characterId,
            memberName,
            memberRole,
            workspace.revision
          )
        : addSharedWorkspaceMember(workspace, activeCharacter.characterId, {
            characterId,
            characterName: memberName,
            role: memberRole
          }, workspace.revision, now())
      installWorkspace(updated)
      setMemberId('')
      setMemberName('')
      setMessage('Member added. They must accept the policy separately.')
    } catch (error) {
      await recoverWorkspaceAfterError(workspace.workspaceId, error)
    } finally {
      setBusy(false)
    }
  }

  const shareWatch = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!workspace || !activeCharacter) return
    const recordId = `character-${watchId.trim()}`
    const current = workspace.records.find((record) =>
      record.collection === 'watchlist' && record.recordId === recordId)
    setBusy(true)
    try {
      const mutation: SharedWorkspaceMutation = {
        operation: 'upsert',
        mutationId: mutationId(),
        collection: 'watchlist',
        recordId,
        expectedRevision: current?.revision ?? 0,
        baseWorkspaceRevision: workspace.revision,
        payload: {
          entityType: 'character',
          entityId: parsePositiveInteger(watchId, 'Target ID'),
          name: watchName,
          severity: watchSeverity,
          tags: ['pro-workspace'],
          note: null
        }
      }
      const result = api
        ? await api.applySharedWorkspaceMutation(workspace.workspaceId, mutation)
        : applySharedWorkspaceMutation(workspace, activeCharacter.characterId, mutation, now())
      if (!result.ok) {
        await recoverWorkspaceAfterError(workspace.workspaceId, new Error(result.message))
        return
      }
      installWorkspace(result.workspace)
      setWatchId('')
      setWatchName('')
      setMessage(result.applied ? 'Target added to the shared watchlist.' : 'Change already applied.')
    } catch (error) {
      await recoverWorkspaceAfterError(workspace.workspaceId, error)
    } finally {
      setBusy(false)
    }
  }

  const selectWorkspace = async (workspaceId: string): Promise<void> => {
    if (!api || !workspaceId) return
    chooseWorkspace(workspaceId)
    latestWorkspaceRef.current = null
    onChange(null)
    setMessage(null)
    try {
      await refreshWorkspace(workspaceId)
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const refreshSelectedWorkspace = async (): Promise<void> => {
    if (!api || !selectedWorkspaceId) return
    setMessage(null)
    try {
      await refreshWorkspace(selectedWorkspaceId)
      setMessage('Room updated to the latest revision.')
      void api.listSharedWorkspaces().then(setWorkspaceSummaries).catch(() => undefined)
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  return (
    <div id="pro-panel-fleet" role="tabpanel" className="pro-panel pro-fleet-panel">
      <div className="pro-panel-heading">
        <div>
          <p className="eyebrow">Corp / Fleet</p>
          <h2>Shared operations workspace</h2>
          <p>Roles, explicit consent, and conflict-safe updates to watchlists, doctrines, and routes.</p>
        </div>
        <div className="pro-workspace-sync-actions">
          {workspace ? <span className="pro-revision-badge">rev {workspace.revision}</span> : null}
          {api && selectedWorkspaceId ? (
            <button
              type="button"
              className="secondary-button"
              disabled={busy || refreshing}
              onClick={() => { void refreshSelectedWorkspace() }}
            >
              {refreshing ? 'Refreshing…' : 'Refresh room'}
            </button>
          ) : null}
        </div>
      </div>

      {api && workspaceSummaries.length > 0 ? (
        <label className="pro-workspace-selector">
          <span>Cloud room</span>
          <select
            value={selectedWorkspaceId}
            disabled={busy || refreshing}
            onChange={(event) => { void selectWorkspace(event.target.value) }}
          >
            {workspaceSummaries.map((summary) => (
              <option key={summary.workspaceId} value={summary.workspaceId}>{summary.name}</option>
            ))}
          </select>
        </label>
      ) : null}

      {!workspace && api && selectedWorkspaceId ? (
        <div className="pro-create-workspace">
          <div>
            <strong>Room is temporarily not loaded</strong>
            <p>Select the room again or request its latest revision.</p>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy || refreshing}
            onClick={() => { void refreshSelectedWorkspace() }}
          >
            {refreshing ? 'Refreshing…' : 'Retry loading'}
          </button>
        </div>
      ) : !workspace ? (
        <div className="pro-create-workspace">
          <div>
            <strong>{api ? 'Create cloud room' : 'Create local room'}</strong>
            <p>{api ? 'Only added characters gain access after explicit consent.' : 'Local mode runs in memory.'}</p>
          </div>
          <label><span>Name</span><input disabled={busy} value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
          <button className="primary-button" type="button" disabled={!activeCharacter || busy} onClick={() => { void create() }}>{busy ? 'Loading…' : 'Create'}</button>
          {!activeCharacter ? <small>First select a character in Multi-character.</small> : null}
        </div>
      ) : (
        <>
          <div className="pro-fleet-summary">
            <article><span>Room</span><strong>{workspace.name}</strong><small>{workspace.workspaceId}</small></article>
            <article><span>Members</span><strong>{workspace.members.length}</strong><small>RBAC: owner / commander / editor / viewer</small></article>
            <article><span>Shared records</span><strong>{liveRecords.length}</strong><small>watchlist · doctrines · routes</small></article>
          </div>

          <section className="pro-consent-card">
            <div>
              <strong>{currentConsent ? 'Sharing allowed' : 'Consent required'}</strong>
              <p>Watchlist, doctrines, and routes. Local presence is off by default.</p>
            </div>
            {!currentConsent ? (
              <>
                <label className="pro-checkbox">
                  <input type="checkbox" checked={sharePresence} onChange={(event) => setSharePresence(event.target.checked)} />
                  <span>Allow Local Presence</span>
                </label>
                <button type="button" className="primary-button" disabled={busy} onClick={() => { void acceptConsent() }}>Accept policy v{workspace.policyVersion}</button>
              </>
            ) : (
              <button type="button" className="secondary-button" disabled={busy} onClick={() => { void revokeConsent() }}>Stop sharing</button>
            )}
          </section>

          <div className="pro-fleet-columns">
            <section className="pro-form-card">
              <strong>Members</strong>
              <div className="pro-member-list">
                {workspace.members.map((member) => (
                  <div key={member.characterId}>
                    <span>{member.characterName}</span>
                    <b>{member.role}</b>
                    <small>{member.consent?.policyVersion === workspace.policyVersion ? 'consent ok' : 'no consent'}</small>
                  </div>
                ))}
              </div>
              <form onSubmit={(event) => { void invite(event) }} className="pro-nested-form">
                <label><span>ID</span><input disabled={busy} inputMode="numeric" value={memberId} onChange={(event) => setMemberId(event.target.value)} /></label>
                <label><span>Name</span><input disabled={busy} value={memberName} onChange={(event) => setMemberName(event.target.value)} /></label>
                <label><span>Role</span><select disabled={busy} value={memberRole} onChange={(event) => setMemberRole(event.target.value as Exclude<SharedWorkspaceRole, 'owner'>)}><option value="commander">commander</option><option value="editor">editor</option><option value="viewer">viewer</option></select></label>
                <button className="secondary-button" type="submit" disabled={!currentConsent || !canManageMembers || busy}>Add</button>
              </form>
              {currentConsent && !canManageMembers ? <p>Only the owner can add members.</p> : null}
            </section>

            <section className="pro-form-card">
              <strong>Shared watchlist</strong>
              <div className="pro-record-list">
                {liveRecords.filter((record) => record.collection === 'watchlist').map((record) => (
                  <div key={record.recordId}>
                    <span>{record.payload?.name ?? record.recordId}</span>
                    <b>{record.payload?.severity}</b>
                    <small>r{record.revision}</small>
                  </div>
                ))}
                {liveRecords.every((record) => record.collection !== 'watchlist') ? <p>Empty for now.</p> : null}
              </div>
              <form onSubmit={(event) => { void shareWatch(event) }} className="pro-nested-form">
                <label><span>Target ID</span><input disabled={busy} inputMode="numeric" value={watchId} onChange={(event) => setWatchId(event.target.value)} /></label>
                <label><span>Name</span><input disabled={busy} value={watchName} onChange={(event) => setWatchName(event.target.value)} /></label>
                <label><span>Level</span><select disabled={busy} value={watchSeverity} onChange={(event) => setWatchSeverity(event.target.value as typeof watchSeverity)}><option value="watch">watch</option><option value="danger">danger</option><option value="critical">critical</option></select></label>
                <button className="secondary-button" type="submit" disabled={!currentConsent || busy}>Share</button>
              </form>
            </section>
          </div>
        </>
      )}

      {message ? <p className="pro-inline-message" role="status">{message}</p> : null}
      <p className="pro-security-note">Rooms and fleet records are not written to renderer localStorage. The cloud receives only explicitly allowed scopes; Local presence is off by default.</p>
    </div>
  )
}

function demoWormholeChain(now: string): WormholeChain {
  const system = (id: string, name: string, isHome = false): WormholeSystemNode => ({
    id,
    solarSystemId: null,
    name,
    isHome,
    firstSeenAt: now,
    lastSeenAt: now
  })
  const connection = (
    id: string,
    from: string,
    to: string,
    massStatus: WormholeConnection['massStatus']
  ): WormholeConnection => ({
    id,
    fromSystemNodeId: from,
    toSystemNodeId: to,
    fromSignatureId: null,
    reverseSignatureId: null,
    wormholeCode: 'K162',
    massStatus,
    lifeStatus: 'stable',
    discoveredAt: now,
    updatedAt: now,
    expiresAt: null
  })
  return {
    systems: [
      system('current', 'J-current'),
      system('safe-hop', 'J-safe'),
      system('home', 'HOME', true)
    ],
    signatures: [],
    connections: [
      connection('direct-critical', 'current', 'home', 'critical'),
      connection('safe-one', 'current', 'safe-hop', 'stable'),
      connection('safe-two', 'safe-hop', 'home', 'stable')
    ]
  }
}

function uniqueNodeId(chain: WormholeChain, name: string): string {
  const base = name
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'system'
  let candidate = base
  let suffix = 2
  while (chain.systems.some((system) => system.id === candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

function buildHunterDemo(
  rows: string,
  timezoneOffset: string,
  bucketMinutes: string
): { plan: HunterPlan | null; error: string | null } {
  try {
    const snapshots = parseHunterRows(rows)
    return {
      plan: buildHunterPlan(snapshots, {
        timezoneOffsetMinutes: parseBoundedInteger(
          timezoneOffset,
          'UTC offset',
          -14 * 60,
          14 * 60
        ),
        activityBucketMinutes: parseBoundedInteger(
          bucketMinutes,
          'Deduplication window',
          5,
          24 * 60
        )
      }),
      error: null
    }
  } catch (error) {
    return { plan: null, error: errorMessage(error) }
  }
}

function parseHunterRows(value: string): EncounterSnapshot[] {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length > 2_000) throw new RangeError('No more than 2000 encounter rows.')
  return lines.map((line, index): EncounterSnapshot => {
    const [capturedRaw, systemIdRaw, systemNameRaw, characterIdRaw, ...pilotParts] = line
      .split('|')
      .map((part) => part.trim())
    const pilotName = pilotParts.join('|').trim()
    const captured = Date.parse(capturedRaw)
    if (!Number.isFinite(captured)) throw new TypeError(`Row ${index + 1}: invalid time.`)
    if (!pilotName) throw new TypeError(`Row ${index + 1}: missing pilot name.`)
    const systemId = parsePositiveInteger(systemIdRaw, `Row ${index + 1}, system ID`)
    const characterId = characterIdRaw
      ? parsePositiveInteger(characterIdRaw, `Row ${index + 1}, character ID`)
      : null
    const timestamp = new Date(captured).toISOString()
    return {
      id: index + 1,
      capturedAt: timestamp,
      recordedAt: timestamp,
      currentSystem: { solarSystemId: systemId, name: systemNameRaw || null },
      ownShip: null,
      localPilots: [{ characterId, name: pilotName, corporationName: null }],
      dscanHulls: []
    }
  })
}

function weekdayName(weekday: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekday] ?? '?'
}

interface DoctrineDemoDraft {
  name: string
  role: DscanShipRole
  roleMinimum: string
  roleTarget: string
  roleMaximum: string
  hull: string
  hullMinimum: string
  hullTarget: string
  hullMaximum: string
  dscan: string
}

function buildDoctrineDemo(
  draft: DoctrineDemoDraft,
  now: string
): { result: DoctrineMatchResult | null; error: string | null } {
  try {
    const template = validateDoctrineTemplateInput({
      name: draft.name,
      roles: [{
        role: draft.role,
        minimum: parseNonNegativeInteger(draft.roleMinimum, 'Role minimum'),
        target: parseNonNegativeInteger(draft.roleTarget, 'Role target'),
        maximum: parseOptionalNonNegativeInteger(draft.roleMaximum, 'Role maximum')
      }],
      hulls: draft.hull.trim() ? [{
        typeName: draft.hull,
        minimum: parseNonNegativeInteger(draft.hullMinimum, 'Hull minimum'),
        target: parseNonNegativeInteger(draft.hullTarget, 'Hull target'),
        maximum: parseOptionalNonNegativeInteger(draft.hullMaximum, 'Hull maximum')
      }] : []
    }, { id: 'renderer-demo', now })
    return { result: matchDscanDoctrine(parseDscanText(draft.dscan), template), error: null }
  } catch (error) {
    return { result: null, error: errorMessage(error) }
  }
}

function parseDscanText(value: string): Array<{ type: string }> {
  const rows: Array<{ type: string }> = []
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (const [index, line] of lines.entries()) {
    const match = /^(.*?)(?:\s+[x×]\s*(\d+))?$/iu.exec(line)
    const name = match?.[1]?.trim() ?? ''
    const count = match?.[2] ? Number(match[2]) : 1
    if (!name || !Number.isSafeInteger(count) || count <= 0 || count > 500) {
      throw new TypeError(`D-scan row ${index + 1}: invalid hull or count.`)
    }
    for (let item = 0; item < count; item += 1) rows.push({ type: name })
    if (rows.length > 2_000) throw new RangeError('D-scan contains more than 2000 objects.')
  }
  return rows
}

function parseOptionalNonNegativeInteger(value: string, label: string): number | null {
  return value.trim() ? parseNonNegativeInteger(value, label) : null
}

function parseBoundedInteger(
  value: string,
  label: string,
  minimum: number,
  maximum: number
): number {
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${label}: allowed range is ${minimum}–${maximum}.`)
  }
  return parsed
}

function buildMarketRadar(
  draft: MarketRadarDraft,
  now: string
): { radar: MarketOpportunityRadar | null; error: string | null } {
  try {
    if (draft.originHubId === draft.destinationHubId) {
      throw new TypeError('Choose different buy and sell hubs.')
    }
    const typeId = parsePositiveInteger(draft.typeId, 'Type ID')
    const quantity = parsePositiveInteger(draft.quantity, 'Quantity')
    const originTotal = parseNonNegativeNumber(draft.originTotalIsk, 'Purchase')
    const destinationTotal = parseNonNegativeNumber(draft.destinationTotalIsk, 'Revenue')
    const candidate: MarketOpportunityCandidate = {
      typeName: draft.typeName,
      unitVolumeM3: parsePositiveNumber(draft.unitVolumeM3, 'Unit volume'),
      originQuote: executableQuote(draft.originHubId, typeId, quantity, originTotal, 'buy', now),
      destinationQuote: executableQuote(
        draft.destinationHubId,
        typeId,
        quantity,
        destinationTotal,
        'sell',
        now
      ),
      route: {
        jumps: parseNonNegativeInteger(draft.jumps, 'Jumps'),
        averageRiskScore: parseRange(draft.averageRiskScore, 'Average risk', 0, 100),
        maximumRiskScore: parseRange(draft.maximumRiskScore, 'Maximum risk', 0, 100),
        campPatternSystems: parseNonNegativeInteger(draft.campPatternSystems, 'Camp systems'),
        confidence: 'medium'
      },
      fees: { rate: parseRange(draft.feePercent, 'Fees', 0, 100) / 100 },
      haulingCostIsk: parseNonNegativeNumber(draft.haulingCostIsk, 'Hauling')
    }
    return {
      radar: rankMarketOpportunities([candidate], {
        riskAversion: parseRange(draft.riskAversionPercent, 'Risk adjustment', 0, 100) / 100
      }, now),
      error: null
    }
  } catch (error) {
    return { radar: null, error: errorMessage(error) }
  }
}

function executableQuote(
  hubId: MarketHubId,
  typeId: number,
  quantity: number,
  total: number,
  executableSide: 'buy' | 'sell',
  fetchedAt: string
): MarketHubQuote {
  const complete = marketFill(quantity, total, true)
  const empty = marketFill(quantity, 0, false)
  const unitPrice = quantity > 0 ? total / quantity : 0
  return {
    hub: getMarketHub(hubId),
    typeId,
    quantity,
    book: {
      bestBuy: executableSide === 'sell' ? unitPrice : null,
      bestSell: executableSide === 'buy' ? unitPrice : null,
      spread: null,
      spreadPercent: null,
      buyOrderCount: executableSide === 'sell' ? 1 : 0,
      sellOrderCount: executableSide === 'buy' ? 1 : 0,
      buyVolume: executableSide === 'sell' ? quantity : 0,
      sellVolume: executableSide === 'buy' ? quantity : 0,
      immediateBuy: executableSide === 'buy' ? complete : empty,
      immediateSell: executableSide === 'sell' ? complete : empty
    },
    regionalOrderCount: 1,
    stationOrderCount: 1,
    history: null,
    cached: false,
    fetchedAt
  }
}

function marketFill(quantity: number, total: number, complete: boolean): MarketFill {
  return {
    requestedQuantity: quantity,
    filledQuantity: complete ? quantity : 0,
    missingQuantity: complete ? 0 : quantity,
    total,
    averagePrice: complete ? total / quantity : null,
    complete,
    ordersUsed: complete ? 1 : 0,
    levels: complete ? [{ price: total / quantity, quantity, orderCount: 1 }] : []
  }
}

function normalizeMarketDraft(value: Record<string, unknown> | MarketRadarDraft): MarketRadarDraft {
  const result = { ...DEFAULT_MARKET_RADAR_DRAFT }
  for (const key of Object.keys(result) as Array<keyof MarketRadarDraft>) {
    const candidate = value[key]
    if (key === 'originHubId' || key === 'destinationHubId') {
      if (typeof candidate === 'string' && MARKET_HUBS.some((hub) => hub.id === candidate)) {
        result[key] = candidate as MarketHubId
      }
    } else if (typeof candidate === 'string' && candidate.length <= 200 && !candidate.includes('\0')) {
      result[key] = candidate
    }
  }
  return result
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label}: a positive whole number is required.`)
  return parsed
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value.trim())
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${label}: a non-negative whole number is required.`)
  return parsed
}

function parsePositiveNumber(value: string, label: string): number {
  const parsed = Number(value.trim().replace(',', '.'))
  if (!Number.isFinite(parsed) || parsed <= 0) throw new TypeError(`${label}: a positive number is required.`)
  return parsed
}

function parseNonNegativeNumber(value: string, label: string): number {
  const parsed = Number(value.trim().replace(',', '.'))
  if (!Number.isFinite(parsed) || parsed < 0) throw new TypeError(`${label}: a non-negative number is required.`)
  return parsed
}

function parseRange(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = parseNonNegativeNumber(value, label)
  if (parsed < minimum || parsed > maximum) throw new TypeError(`${label}: allowed range is ${minimum}–${maximum}.`)
  return parsed
}

function formatIsk(value: number): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)} ISK`
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value)}%`
}

function browserStorage(): ProWorkspaceStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function mutationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `renderer-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : value as number
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : value as string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error.'
}
