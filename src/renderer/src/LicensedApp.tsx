import { useCallback } from 'react'
import type { EveLocalIntelApi } from '../../shared/types'
import App from './App'
import { CharacterGate } from './CharacterGate'
import { PRO_FEATURE_IDS } from '../../shared/pro-features'

export default function LicensedApp(): React.JSX.Element {
  const api = getApi()

  const getAccountStatus = useCallback(async () => {
    if (!api) throw new Error('EVE SSO module unavailable')
    return api.getAccountStatus()
  }, [api])

  const restoreAccount = useCallback(async () => {
    if (!api) throw new Error('EVE SSO module unavailable')
    return api.restoreAccount()
  }, [api])

  const connectAccount = useCallback(async () => {
    if (!api) throw new Error('EVE SSO module unavailable')
    return api.connectAccount()
  }, [api])

  const cancelAccountConnect = useCallback(async () => {
    if (!api) throw new Error('EVE SSO module unavailable')
    await api.cancelAccountConnect()
  }, [api])

  return (
    <CharacterGate
      getAccountStatus={getAccountStatus}
      restoreAccount={restoreAccount}
      connectAccount={connectAccount}
      cancelAccountConnect={cancelAccountConnect}
    >
      <App entitlementFeatures={PRO_FEATURE_IDS} />
    </CharacterGate>
  )
}

function getApi(): EveLocalIntelApi | null {
  return (window as Window & { eveIntel?: EveLocalIntelApi }).eveIntel ?? null
}
