import { useCallback, useEffect, useRef, useState } from 'react'
import { industryProductionMarketValue, type IndustryProducedView } from '../../shared/industry-production'
import type { MarketHubQuote } from '../../shared/market'
import { MarketOrderDepthDialog } from './MarketOrderDepth'
import type { ProductionMarketQuoteQueue } from './industry-market-queue'

const money = (n: number | null): string => n === null ? 'нет оценки' : `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ISK`
export function IndustryProductionMarket({ row, queue, active, salesTaxPercent = 7.5, salesTaxSource = 'base' }: { row: IndustryProducedView; queue: ProductionMarketQuoteQueue | null; active: boolean; salesTaxPercent?: number; salesTaxSource?: 'skills' | 'base' }): React.JSX.Element {
  const node = useRef<HTMLElement>(null), sequence = useRef(0)
  const [visible, setVisible] = useState(false)
  const [quote, setQuote] = useState<MarketHubQuote | null>(null)
  const [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null)
  const [depth, setDepth] = useState(false)
  const [clock, setClock] = useState(Date.now())
  useEffect(() => {
    if (!active || !node.current) { setVisible(false); return }
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { rootMargin: '120px' })
    observer.observe(node.current); return () => observer.disconnect()
  }, [active])
  const load = useCallback(async (force = false): Promise<void> => {
    if (!queue || !row.job.productTypeId) return
    const seq = ++sequence.current
    setLoading(true); setError(null)
    try { const result = await queue.request(row.job.productTypeId, row.outputQuantity, force); if (seq === sequence.current) { setQuote(result); setClock(Date.now()) } }
    catch (e) { if (seq === sequence.current) setError(e instanceof Error ? e.message : 'Рынок недоступен') }
    finally { if (seq === sequence.current) setLoading(false) }
  }, [queue, row.job.productTypeId, row.outputQuantity])
  useEffect(() => {
    if (!active || !visible) return
    void load()
    const timer = setInterval(() => { setClock(Date.now()); void load() }, 60000)
    return () => { sequence.current++; clearInterval(timer); setLoading(false) }
  }, [active, visible, load])
  const matchingQuote = quote?.typeId === row.job.productTypeId && quote.quantity === row.outputQuantity ? quote : null
  const value = matchingQuote ? industryProductionMarketValue(row, matchingQuote, salesTaxPercent) : null
  const stale = quote ? clock - Date.parse(quote.snapshotAt ?? quote.fetchedAt) > 600000 || !!quote.expiresAt && Date.parse(quote.expiresAt) <= clock : false
  const profit = (n: number | null, net: number | null): React.JSX.Element => <strong className={n === null ? '' : n >= 0 ? 'industry-positive' : 'industry-negative'}>{n === null ? net === null ? 'нет рыночной оценки' : 'после расчёта себестоимости' : `${n > 0 ? '+' : ''}${money(n)}`}</strong>
  return <section className="industry-produced-market" ref={node} aria-label="Текущая рыночная стоимость продукции">
    <header><h4>Рынок Jita · вся партия {row.outputQuantity.toLocaleString('ru-RU')} шт.</h4><button className="secondary-button" disabled={!queue || loading} onClick={() => void load(true)}>{loading ? 'Обновляю рынок…' : 'Обновить рынок'}</button></header>
    {error && <p role="alert" className="industry-warning">{error}. Повторите обновление.</p>}
    {!value && <p>{loading ? 'Получаю BUY / SELL из ESI…' : 'Рыночная оценка загрузится при просмотре карточки.'}</p>}
    {value && matchingQuote && <><div className="industry-produced-market-pair"><div><h4>BUY · продать сейчас</h4><p>Лучший BUY: {money(matchingQuote.book.bestBuy)} / шт.</p><strong>{money(value.buy.net)}</strong><small>Вся партия после налога</small><p>Результат к себестоимости: {profit(value.buy.profit, value.buy.net)}</p>{!value.buy.complete && <p className="industry-warning">Не хватает BUY для всей партии: исполнимо {value.buy.filled.toLocaleString('ru-RU')} из {row.outputQuantity.toLocaleString('ru-RU')} шт. Полная выручка не рассчитана.</p>}</div>
      <div><h4>SELL · выставить ордер</h4><p>Минимальный SELL: {money(value.sell.unitPrice)} / шт.</p><strong>{money(value.sell.net)}</strong><small>Оценка всей партии после налога и брокера</small><p>Результат к себестоимости: {profit(value.sell.profit, value.sell.net)}</p><p className="industry-warning">Цена конкурентов, не обещание продажи или срока ожидания.</p></div></div>
      <details><summary>До налогов и допущения</summary><p>BUY до налога: {money(value.buy.gross)}; лимит продажи всей партии: {money(value.buy.unitPrice)} / шт. SELL до комиссий: {money(value.sell.gross)}.</p><p>Налог продажи {salesTaxPercent.toLocaleString('ru-RU', { maximumFractionDigits: 4 })}% · {salesTaxSource === 'skills' ? 'по навыку Accounting персонажа' : 'базовое допущение: навык Accounting недоступен'}. Брокер SELL: базовое допущение 3%; BUY без брокерской комиссии. Перевыставления и доставка не добавлены.</p><p>Оценка всего произведённого объёма, не подтверждение остатка в ангаре. Только ордера Jita IV–4; BUY с других станций по радиусу сюда не включены. BUY рассчитан одним лимитом для всей партии, с учётом глубины и минимальных лотов.</p></details>
      <div className="industry-actions"><small>Снимок ESI: {new Date(matchingQuote.snapshotAt ?? matchingQuote.fetchedAt).toLocaleString('ru-RU')}{matchingQuote.cached ? ' · кэш' : ''}.</small><button className="secondary-button" onClick={() => setDepth(true)}>Стакан BUY / SELL</button></div>
      {stale && <p className="industry-warning">Снимок устарел. Обновите рынок перед решением.</p>}
      {depth && <MarketOrderDepthDialog quote={matchingQuote} onClose={() => setDepth(false)} />}
    </>}
  </section>
}
