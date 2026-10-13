import { readFile } from 'node:fs/promises'
import { EveJwtVerifier, EveRefreshTokenProvider, FileRefreshTokenStore } from './auth.js'
import { BillingService } from './billing-service.js'
import { loadConfig } from './config.js'
import { seedDefaultPlans } from './default-plans.js'
import { assertEntitlementSignerMatchesDesktopTrust } from './desktop-entitlement-trust.js'
import { EntitlementService, EntitlementSigner } from './entitlement.js'
import { EsiWalletJournalClient, WalletPollService } from './esi-wallet.js'
import { createApiServer } from './http-api.js'
import { SqliteBillingStore } from './store.js'
import { WorkspaceService } from './workspace-service.js'
import { ZkillRelayService } from './zkill-relay.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const privateKey = await readFile(config.entitlementPrivateKeyPath)
  const signer = new EntitlementSigner({ privateKey, keyId: config.entitlementKeyId })
  assertEntitlementSignerMatchesDesktopTrust(signer)

  const store = new SqliteBillingStore(config.databasePath)
  seedDefaultPlans(store)
  const entitlements = new EntitlementService({
    store,
    signer,
    graceSeconds: config.entitlementGraceSeconds
  })
  const billing = new BillingService({
    store,
    entitlementService: entitlements,
    cashierCharacterId: config.cashierCharacterId,
    renewalLeadSeconds: config.renewalLeadSeconds,
    maxDevicesPerCharacter: config.maxDevicesPerCharacter
  })
  const tokenProvider = new EveRefreshTokenProvider({
    clientId: config.eveClientId,
    clientSecret: config.eveClientSecret,
    refreshToken: config.cashierRefreshToken,
    refreshTokenStore: config.cashierRefreshTokenPath
      ? new FileRefreshTokenStore(config.cashierRefreshTokenPath, config.cashierRefreshToken)
      : undefined
  })
  const walletClient = new EsiWalletJournalClient({
    userAgent: config.esiUserAgent,
    compatibilityDate: config.esiCompatibilityDate
  })
  const walletPoll = new WalletPollService({
    store,
    billing,
    client: walletClient,
    tokenProvider,
    cashierCharacterId: config.cashierCharacterId
  })
  const auth = new EveJwtVerifier({ clientId: config.eveClientId })
  const workspaces = new WorkspaceService({ store })
  const zkillRelay = new ZkillRelayService({
    zkillBaseUrl: config.zkillBaseUrl,
    r2z2BaseUrl: config.r2z2BaseUrl,
    userAgent: config.zkillRelayUserAgent
  })
  const server = createApiServer({
    auth,
    billing,
    entitlements,
    workspaces,
    adminToken: config.adminToken,
    walletPoll,
    publicBaseUrl: config.publicBaseUrl,
    zkillRelay
  })

  let backgroundWork: Promise<void> | null = null
  const tick = (): void => {
    if (backgroundWork) return
    backgroundWork = (async () => {
      try {
        const wallet = await walletPoll.poll()
        const renewed = billing.renewEligibleSubscriptions()
        if (!wallet.skipped || renewed.length > 0) {
          console.info({ event: 'billing_tick', wallet, renewed: renewed.length })
        }
      } catch (error) {
        console.error({ event: 'billing_tick_failed', error })
      }
    })().finally(() => {
      backgroundWork = null
    })
  }
  const interval = setInterval(tick, config.walletPollIntervalSeconds * 1_000)
  tick()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      console.info({ event: 'server_started', host: config.host, port: config.port })
      resolve()
    })
  })

  const shutdown = (signal: string): void => {
    clearInterval(interval)
    console.info({ event: 'server_stopping', signal })
    server.close(() => {
      store.close()
      process.exitCode = 0
    })
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

void main().catch((error: unknown) => {
  console.error({ event: 'startup_failed', error })
  process.exitCode = 1
})
