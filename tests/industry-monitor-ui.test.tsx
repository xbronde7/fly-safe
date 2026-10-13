import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IndustryMonitorPanel } from '../src/renderer/src/IndustryMonitorPanel'
import { IndustryProductionWorkspace, IndustryProducedCard, ProductionCostEditor } from '../src/renderer/src/IndustryProductionWorkspace'
import { industryProducedJob, industryProducedView } from '../src/shared/industry-production'
import { shouldProcessAutomaticClipboard } from '../src/shared/clipboard-view'
import { industryCatalog as catalog, industryRequest as request } from './industry-fixtures'

describe('BPC monitoring and manufactured-product UI', () => {
  it('is opt-in and explains the purchase-only scope, notification controls and ESI delay', () => {
    const html = renderToStaticMarkup(<IndustryMonitorPanel api={null} active request={request} />)
    expect(html).toContain('Включить монитор'); expect(html).toContain('Свои чертежи и запасы исключены')
    expect(html).toContain('Минимум прибыли 1 прогона'); expect(html).toContain('Пороги уведомлений')
    expect(html).toContain('до 30 минут'); expect(html).toContain('не все регионы New Eden')
    expect(html).toContain('не покупается автоматически')
  })
  it('explains automatic material costing without a manual contract/purchase workflow', () => {
    const html = renderToStaticMarkup(<IndustryProductionWorkspace api={null} active />)
    expect(html).toContain('Готовая продукция'); expect(html).toContain('Купленные готовые товары из Hangar сюда не попадают')
    expect(html).toContain('Материалы и запуск подставляются автоматически'); expect(html).toContain('не ноль')
    expect(html).toContain('без поиска ID контракта'); expect(html).toContain('0,25%'); expect(html).toContain('фактически списанная сумма ESI')
    expect(shouldProcessAutomaticClipboard('production')).toBe(false)
  })
  it('asks only for BPC price/runs, no transaction allocations, contract ID or extras', () => {
    const record = industryProducedJob({ jobId: 1, activityId: 1, blueprintTypeId: 101, blueprintItemId: 2, productTypeId: 100, runs: 2, status: 'ready', startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-02T00:00:00Z', facilityId: 60003760, stationId: 60003760, cost: 123 }, catalog, '2026-10-01T00:00:00Z')!
    const row = industryProducedView(record, null, [])
    const html = renderToStaticMarkup(<ProductionCostEditor row={row} onSave={async () => {}} />)
    expect(html).toContain('Цена BPC'); expect(html).toContain('Прогоны BPC')
    expect(html).not.toContain('Расход сделки'); expect(html).not.toContain('ID оплаченного контракта')
    expect(html).not.toContain('прочие затраты'); expect(html).not.toContain('checkbox')
    expect(html).toContain('Сохранить стоимость чертежа')
  })
  it('starts the transaction editor collapsed and does not label unknown production free', () => {
    const record = industryProducedJob({ jobId: 1, activityId: 1, blueprintTypeId: 101, blueprintItemId: 2, productTypeId: 100, runs: 2, status: 'ready', startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-02T00:00:00Z', facilityId: 60003760, stationId: 60003760, cost: 123 }, catalog, '2026-10-01T00:00:00Z')!
    const row = industryProducedView(record, null, [])
    const html = renderToStaticMarkup(<IndustryProducedCard row={row} snapshot={{ characterId: 901, rows: [row], purchases: [], warnings: [], syncedAt: null }} onSave={async () => {}} />)
    expect(html).toContain('Test Product'); expect(html).toContain('20 шт.')
    expect(html).toContain('готово, ещё не забрано'); expect(html).toContain('не подтверждено')
    expect(html).not.toMatch(/<details[^>]*\bopen[=> ]/)
    expect(html).not.toContain('<table>')
  })
})
