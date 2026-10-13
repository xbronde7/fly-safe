import type { IndustryCatalog, IndustryRecipe, IndustryScanRequest, IndustrySkill, IndustryBlueprint } from '../src/shared/industry'
import type { MarketOrder } from '../src/shared/market'
import type { EconomyTransactionRow } from '../src/shared/personal-economy'
export const industryPurchase: EconomyTransactionRow = { transactionId: 11, date: '2026-10-01T01:00:00Z', typeId: 34, quantity: 20, unitPrice: 2, buy: true, personal: true, locationId: 60003760, clientId: 901 }
export const industryRequest: IndustryScanRequest = {
  scanId: 'test_scan', buyHubId: 'jita', sellHubId: 'jita', blueprintHubIds: ['jita'], blueprintMode: 'buy',
  runs: 2, productionSystem: 'Perimeter', facilityTaxPercent: 0.25, sccPercent: 4,
  materialReductionPercent: 0, timeReductionPercent: 0, jobCostReductionPercent: 0, clone: 'omega', transportCost: 10
}
export const industryRecipe: IndustryRecipe = {
  blueprintTypeId: 101, name: 'Test Blueprint', productTypeId: 100, productName: 'Test Product', productNameRu: '',
  productQuantity: 10, time: 3600, maxRuns: 1, marketable: true,
  materials: [{ typeId: 34, quantity: 10 }, { typeId: 35, quantity: 1 }], skills: [{ typeId: 3380, level: 1 }]
}
export const industryCatalog: IndustryCatalog = {
  build: 123, releasedAt: '2026-09-30T11:00:00Z', source: 'https://developers.eveonline.com/static-data/', blueprints: [industryRecipe],
  types: { 34: { name: 'Tritanium', nameRu: '', volume: 0.01 }, 35: { name: 'Pyerite', nameRu: '', volume: 0.01 }, 100: { name: 'Test Product', nameRu: '', volume: 1 } },
  skills: { 3380: { name: 'Industry', nameRu: '', required: [], timeBonus: -4 }, 3388: { name: 'Advanced Industry', nameRu: '', required: [{ typeId: 3380, level: 3 }], timeBonus: -3 } },
  stations: { 60003760: 30000142, 60000004: 30002780 }, systems: { 30000142: 'Jita', 30002780: 'Muvolailen' }
}
export const industrySkills: IndustrySkill[] = [
  { typeId: 3380, activeLevel: 5, trainedLevel: 5 }, { typeId: 3388, activeLevel: 5, trainedLevel: 5 },
  { typeId: 16622, activeLevel: 5, trainedLevel: 5 }
]
export const ownIndustryBlueprint: IndustryBlueprint = {
  itemId: 900000001, typeId: 101, locationId: 60003760, locationFlag: 'Hangar', quantity: -1, runs: -1,
  materialEfficiency: 10, timeEfficiency: 20
}
export function industryOrder(typeId: number, price: number, isBuyOrder = false, volumeRemain = 10000, overrides: Partial<MarketOrder> = {}): MarketOrder {
  return { orderId: typeId * 1000 + price, typeId, price, isBuyOrder, volumeRemain, volumeTotal: volumeRemain, minVolume: 1,
    locationId: 60003760, systemId: 30000142, issued: '2026-09-30T00:00:00Z', durationDays: 90, range: 'station', ...overrides }
}
