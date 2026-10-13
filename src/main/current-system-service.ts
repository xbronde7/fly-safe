import type { EveAuthorizedSession } from './account-service'
import type {
  AuthenticatedCharacterLocation,
  AuthenticatedCharacterOnline,
  AuthenticatedCharacterShip,
  UniverseName
} from './esi-client'
import type {
  CurrentSystemSnapshot,
  EveAccountStatus,
  SystemIntel
} from '../shared/types'

export interface CurrentSystemAccountAdapter {
  getAuthorizedSession(): Promise<EveAuthorizedSession | null>
  getStatus(): Promise<EveAccountStatus>
}

export interface CurrentSystemEsiAdapter {
  getAuthenticatedCharacterOnline(
    characterId: number,
    accessToken: string
  ): Promise<AuthenticatedCharacterOnline>
  getAuthenticatedCharacterLocation(
    characterId: number,
    accessToken: string
  ): Promise<AuthenticatedCharacterLocation>
  getAuthenticatedCharacterShip(
    characterId: number,
    accessToken: string
  ): Promise<AuthenticatedCharacterShip>
  getUniverseNames(ids: readonly number[], forceRefresh?: boolean): Promise<UniverseName[]>
}

export interface CurrentSystemIntelAdapter {
  getSystemIntel(solarSystemId: number): Promise<SystemIntel>
}

export interface CurrentSystemServiceOptions {
  now?: () => Date
}

/** Joins authenticated character state with public, historical system intelligence. */
export class CurrentSystemService {
  private readonly now: () => Date
  private inFlight: Promise<CurrentSystemSnapshot> | null = null

  constructor(
    private readonly accountService: CurrentSystemAccountAdapter,
    private readonly esi: CurrentSystemEsiAdapter,
    private readonly systemIntel: CurrentSystemIntelAdapter,
    options: CurrentSystemServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
  }

  /** Concurrent renderer refreshes share one authenticated ESI request set. */
  getCurrentSystem(): Promise<CurrentSystemSnapshot> {
    if (this.inFlight) return this.inFlight

    const operation = this.buildSnapshot()
    this.inFlight = operation
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = null
    }).catch(() => undefined)
    return operation
  }

  private async buildSnapshot(): Promise<CurrentSystemSnapshot> {
    const warnings: string[] = []
    let authorized: EveAuthorizedSession | null = null

    try {
      authorized = await this.accountService.getAuthorizedSession()
    } catch (error) {
      warnings.push(`EVE SSO: session unavailable (${messageOf(error)})`)
    }

    const account = cloneAccountStatus(await this.accountService.getStatus())
    if (!authorized) return this.snapshot(account, null, null, null, null, warnings)

    const { characterId } = authorized.session
    const accessToken = authorized.accessToken
    let online: AuthenticatedCharacterOnline
    try {
      // Location and ship are meaningful only after ESI confirms the character is online.
      online = await this.esi.getAuthenticatedCharacterOnline(characterId, accessToken)
    } catch (error) {
      warnings.push(`ESI: pilot status unavailable (${messageOf(error, accessToken)})`)
      return this.snapshot(account, null, null, null, null, warnings)
    }

    if (!online.online) return this.snapshot(account, false, null, null, null, warnings)

    const [locationResult, shipResult] = await Promise.allSettled([
      this.esi.getAuthenticatedCharacterLocation(characterId, accessToken),
      this.esi.getAuthenticatedCharacterShip(characterId, accessToken)
    ])

    if (locationResult.status === 'rejected') {
      warnings.push(
        `ESI: current system unavailable (${messageOf(locationResult.reason, accessToken)})`
      )
    }
    if (shipResult.status === 'rejected') {
      warnings.push(
        `ESI: current ship unavailable (${messageOf(shipResult.reason, accessToken)})`
      )
    }

    const location = fulfilledValue(locationResult)
    const ship = fulfilledValue(shipResult)
    const [intelResult, shipNameResult] = await Promise.allSettled([
      location
        ? this.systemIntel.getSystemIntel(location.solarSystemId)
        : Promise.resolve<SystemIntel | null>(null),
      ship
        ? this.esi.getUniverseNames([ship.shipTypeId])
        : Promise.resolve<UniverseName[]>([])
    ])

    let intel: SystemIntel | null = null
    if (intelResult.status === 'fulfilled') {
      intel = intelResult.value
        ? cloneIntelWithoutOwnPilot(intelResult.value, characterId)
        : null
    } else {
      warnings.push(`System data unavailable (${messageOf(intelResult.reason)})`)
    }

    let typeName: string | null = null
    if (shipNameResult.status === 'fulfilled') {
      typeName = shipNameResult.value.find((item) => item.id === ship?.shipTypeId)?.name ?? null
      if (ship && typeName === null) warnings.push('ESI: ship type name not found')
    } else {
      warnings.push(`ESI: ship name unavailable (${messageOf(shipNameResult.reason)})`)
    }

    const ownShip = ship
      ? {
          typeId: ship.shipTypeId,
          typeName,
          customName: ship.shipName || null
        }
      : null

    return this.snapshot(
      account,
      true,
      location
        ? {
            solarSystemId: location.solarSystemId
          }
        : null,
      ownShip,
      intel,
      warnings
    )
  }

  private snapshot(
    account: EveAccountStatus,
    online: boolean | null,
    location: CurrentSystemSnapshot['location'],
    ownShip: CurrentSystemSnapshot['ownShip'],
    intel: SystemIntel | null,
    warnings: string[]
  ): CurrentSystemSnapshot {
    return {
      account,
      online,
      location,
      ownShip,
      intel,
      fetchedAt: this.now().toISOString(),
      warnings: [...warnings]
    }
  }
}

function cloneAccountStatus(status: EveAccountStatus): EveAccountStatus {
  return {
    configured: status.configured,
    connected: status.connected,
    clientId: status.clientId,
    callbackUri: status.callbackUri,
    characterId: status.characterId,
    characterName: status.characterName,
    scopes: [...status.scopes],
    error: status.error,
    sessionOnly: status.sessionOnly
  }
}

function cloneIntelWithoutOwnPilot(intel: SystemIntel, characterId: number): SystemIntel {
  return {
    ...intel,
    system: { ...intel.system },
    lastHour: { ...intel.lastHour },
    zkill24h: {
      ...intel.zkill24h,
      latest: intel.zkill24h.latest.map((killmail) => ({ ...killmail })),
      observedShips: intel.zkill24h.observedShips.map((ship) => ({
        ...ship,
        pilots: ship.pilots
          .filter((pilot) => pilot.characterId !== characterId)
          .map((pilot) => ({ ...pilot })),
        occurrences: ship.occurrences
          .filter((occurrence) => occurrence.pilotCharacterId !== characterId)
          .map((occurrence) => ({ ...occurrence }))
      })),
      observedPilots: intel.zkill24h.observedPilots
        .filter((pilot) => pilot.characterId !== characterId)
        .map((pilot) => ({ ...pilot, shipTypeIds: [...pilot.shipTypeIds] }))
    },
    danger: {
      ...intel.danger,
      reasons: [...intel.danger.reasons],
      factors: intel.danger.factors.map((factor) => ({ ...factor }))
    },
    warnings: [...intel.warnings],
    provenance: { ...intel.provenance }
  }
}

function fulfilledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null
}

function messageOf(error: unknown, secret?: string): string {
  const message = error instanceof Error && error.message ? error.message : 'unknown error'
  return secret && message.includes(secret) ? message.split(secret).join('[redacted]') : message
}
