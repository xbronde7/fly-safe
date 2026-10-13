import type { EveLocalIntelApi } from '../shared/types'

declare global {
  interface Window {
    eveIntel: EveLocalIntelApi
  }
}

export {}
