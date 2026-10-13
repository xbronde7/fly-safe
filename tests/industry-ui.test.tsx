import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IndustryWorkspace, IndustryJobCard, IndustryOpportunityCard, IndustryPlanningCard } from '../src/renderer/src/IndustryWorkspace'
import { planIndustryOpportunity, industryLiquidity } from '../src/shared/industry-planning'
import { industryBuyDecision } from '../src/shared/industry-decision'
import { calculateIndustryOpportunity, type IndustryJob } from '../src/shared/industry'
import { shouldProcessAutomaticClipboard } from '../src/shared/clipboard-view'
import { IndustryPurchaseJournal } from '../src/renderer/src/IndustryPurchaseJournal'
import { industryPurchaseBasis } from '../src/shared/industry-ledger'
import { industryPurchase as purchase } from './industry-fixtures'
import { industryCatalog as catalog, industryRecipe as recipe, industryRequest as request, industrySkills as skills, industryOrder as order } from './industry-fixtures'
describe('manufacturing UI', () => {
  it('shows actual transaction quantity, paid unit price, total and accounting caveats', () => {
    const html = renderToStaticMarkup(<IndustryPurchaseJournal ledger={{ characterId: 901, syncedAt: purchase.date, warnings: [], transactions: [{ ...purchase, typeName: 'Tritanium' }] }} loading={false} error={null} since="2026-09-30" onSince={() => {}} onRefresh={() => {}} />)
    expect(html).toContain('Tritanium'); expect(html).toContain('2 ISK'); expect(html).toContain('40 ISK')
    expect(html).toContain('История покупок — не остатки Hangar'); expect(html).toContain('не прибыль производства')
    expect(html).toContain('Clear cache'); expect(html).toContain('UTC')
    expect(html).toContain('Показать список сделок')
    expect(html).not.toMatch(/<details[^>]*\bopen[=> ]/)
  })
  it('shows historical-price profit separately from replacement-market profit', () => {
    const row = calculateIndustryOpportunity({ recipe, catalog, request, skills, systemCostIndex: 0.1,
      buyOrders: new Map([[34, [order(34, 5)]], [35, [order(35, 20)]]]), sellOrders: new Map([[100, [order(100, 30, true)]]]),
      blueprintOrders: new Map([[101, [order(101, 100)]]]), adjustedPrices: new Map([[34, 4], [35, 15]]) })
    const purchases = industryPurchaseBasis([purchase, { ...purchase, transactionId: 12, typeId: 35, quantity: 2, unitPrice: 10 }], '2026-09-30')
    const html = renderToStaticMarkup(<IndustryOpportunityCard row={row} materialMode="purchases" purchases={purchases} purchaseSince="2026-09-30" />)
    expect(html).toContain('По вашим покупкам'); expect(html).toContain('Прибыль партии по ценам покупок')
    expect(html).toContain('60 ISK'); expect(html).toContain('не точное списание со склада')
    const missing = renderToStaticMarkup(<IndustryOpportunityCard row={row} materialMode="purchases" purchases={new Map()} />)
    expect(missing).toContain('Себестоимость и прибыль неизвестны')
  })
  it('disables computation without SSO skill data and makes manual execution clear', () => {
    const html = renderToStaticMarkup(<IndustryWorkspace api={null} active />)
    expect(html).toContain('Производство'); expect(html).toContain('вручную в EVE')
    expect(html).toContain('Без активных навыков расчёт заблокирован')
    expect(html).toContain('Найти прибыль'); expect(html).toContain('disabled=""')
    expect(html).toContain('База публичных контрактов')
    expect(html).toContain('BUY · продать сразу'); expect(html).toContain('SELL · выставить ордер')
    expect(html).not.toContain('Количество готового товара, шт.')
    expect(html).not.toContain('Способ продажи<select')
    expect(html).not.toContain('Источник чертежа<select')
    expect(html).not.toContain('Прибыль<select')
    expect(html).toContain('value="Jita"')
    expect(html).toContain('Чертежи объединены')
    expect(html).toContain('Только рынок · купить всё по SELL'); expect(html).toContain('Свои запасы + докупить с рынка')
    expect(html).toMatch(/checked=""[^>]*\/?>Прибыльные в BUY/)
    expect(html).toMatch(/checked=""[^>]*\/?>Хватает покупателей, ресурсов и навыков/)
    expect(html).toContain('<option value="profit" selected="">BUY · прибыль длинной партии</option>')
    expect(html).toContain('Производственных линий')
    expect(html).toContain('Минимум часов на одно задание')
  })
  it('shows one run, a full copy and feasible material/buyer batches with BUY and SELL together', () => {
    const row = planIndustryOpportunity({ recipe, catalog, request: { ...request, autoPlan: true, blueprintMode: 'contracts' }, skills, systemCostIndex: 0.1,
      contractBlueprint: { contractId: 22, typeId: 101, price: 90, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '', copy: true, me: 0, te: 0, runs: 100, bundled: false },
      buyOrders: new Map([[34, [order(34, 5, false, 20)]], [35, [order(35, 20)]]]), sellOrders: new Map([[100, [order(100, 30, true, 20), order(100, 40)]]]),
      blueprintOrders: new Map(), adjustedPrices: new Map([[34, 4], [35, 15]]) })
    const demand = industryLiquidity(100, 10000002, [{ date: '2026-10-01', volume: 1, average: 40, highest: 40, lowest: 40, orderCount: 1 }], '2026-10-01', '2026-10-03T00:00:00Z', Date.parse('2026-10-03T00:00:00Z'))
    const html = renderToStaticMarkup(<IndustryPlanningCard row={row} liquidity={demand} />)
    expect(html).toContain('Весь BPC'); expect(html).toContain('Выбранная партия BUY')
    expect(html).toContain('BUY · продать сразу'); expect(html).toContain('SELL · ордер, ждать')
    expect(html).toContain('Не хватает материалов'); expect(html).toContain('Низкая ликвидность')
    expect(html).toContain('Дни с продажами: 1/30'); expect(html).toContain('НЕ отдельная станция Jita')
    expect(html).toContain('Материалы + запуск + доставка + расход BPC')
    expect(html).toContain('BUY · ISK / час одного слота')
    expect(html).toContain('SELL не влияет на рейтинг')
    expect(html).toContain('не гарантия продажи после крафта')
    expect(html).toContain('Это масштаб партии, не срок продажи')
    expect(html).not.toMatch(/<details[^>]*\bopen[=> ]/)
  })
  it('shows economics, future-market caveat, blueprint location, and net shopping stock', () => {
    const row = calculateIndustryOpportunity({ recipe, catalog, request, skills, systemCostIndex: 0.1,
      buyOrders: new Map([[34, [order(34, 5)]], [35, [order(35, 20)]]]), sellOrders: new Map([[100, [order(100, 30, true)]]]),
      blueprintOrders: new Map([[101, [order(101, 100)]]]), adjustedPrices: new Map([[34, 4], [35, 15]]) })
    const html = renderToStaticMarkup(<IndustryOpportunityCard row={row} stock={new Map([[34, 10]])} useStock />)
    expect(html).toContain('Материалы · sell'); expect(html).toContain('Выручка · buy')
    expect(html).toContain('Налог 3.375%'); expect(html).toContain('цена может измениться')
    expect(html).toContain('в Hangar 10 · купить 10'); expect(html).toContain('Multibuy')
    expect(html).toContain('60003760'); expect(html).not.toContain('private-industry-token')
    expect(html).toContain('Test Blueprint'); expect(html).toContain('Навыки · ваш / требуется')
    expect(html).toContain('Industry 5/1'); expect(html).toContain('sell 5 ISK / шт.')
    expect(html).toContain('Прибыль на прогон =')
    expect(html).toContain('Стоимость 1 прогона'); expect(html).toContain('Проверенный лимит партии')
    expect(html).toContain('industry-totals'); expect(html).toContain('Брокерская комиссия')
  })
  it('uses the supplied ranked batch in its primary metrics, not a fresh one-run or SELL estimate', () => {
    const row = planIndustryOpportunity({ recipe, catalog, request: { ...request, blueprintMode: 'contracts' }, skills, systemCostIndex: 0.1,
      contractBlueprint: { contractId: 22, typeId: 101, price: 100, locationId: 60003760, expires: '2099-10-30T00:00:00Z', title: '', copy: true, me: 0, te: 0, runs: 10, bundled: false },
      buyOrders: new Map([[34, [order(34, 5)]], [35, [order(35, 20)]]]), sellOrders: new Map([[100, [order(100, 30, true, 10), order(100, 25, true, 90), order(100, 1e9)]]]),
      blueprintOrders: new Map(), adjustedPrices: new Map([[34, 4], [35, 15]]) })
    const decision = industryBuyDecision(row, { sort: 'profit' })
    expect(decision.quote.runs).toBe(10)
    const html = renderToStaticMarkup(<IndustryPlanningCard row={row} decision={decision} />)
    const headline = html.split('<div class="industry-buy-decision')[1].split('<details')[0]
    expect(headline).toContain('10 прогонов → 100 шт.')
    expect(headline).toContain('BUY принимает 100 из 100 шт.')
    expect(headline).not.toContain('SELL')
    expect(headline).toContain('Стоимость 1 прогона с налогом')
  })
  it('shows an unprofitable calculation and skill requirements instead of hiding the card', () => {
    const row = calculateIndustryOpportunity({ recipe, catalog, request, skills: [], systemCostIndex: 0.1,
      buyOrders: new Map([[34, [order(34, 5)]], [35, [order(35, 20)]]]), sellOrders: new Map([[100, [order(100, 1, true)]]]),
      blueprintOrders: new Map([[101, [order(101, 100)]]]), adjustedPrices: new Map([[34, 4], [35, 15]]) })
    expect(row.profit).toBeLessThan(0)
    const html = renderToStaticMarkup(<IndustryOpportunityCard row={row} />)
    expect(html).toContain('Industry 0/1'); expect(html).toContain('нужно обучить'); expect(html).toContain('Test Blueprint')
    expect(html).toContain('Материалы · sell'); expect(html).toContain('Есть ограничения')
  })
  it('does not claim a paused job is ready just because its end time is in the past', () => {
    const job = { status: 'paused', productName: 'Venture', runs: 2, stationId: 60003760, endDate: '2026-09-29T00:00:00Z', cost: 123 } as IndustryJob
    expect(renderToStaticMarkup(<IndustryJobCard job={job} now={Date.now()} />)).toContain('Приостановлено')
    const ready = renderToStaticMarkup(<IndustryJobCard job={{ ...job, status: 'ready' }} now={Date.now()} />)
    expect(ready).toContain('заберите в EVE'); expect(ready).not.toContain('Приостановлено')
  })
  it('owns its Multibuy clipboard without triggering a pilot lookup', () => {
    expect(shouldProcessAutomaticClipboard('industry')).toBe(false)
  })
})
