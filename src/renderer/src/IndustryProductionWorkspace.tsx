import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EveLocalIntelApi } from '../../shared/types'
import type { IndustryProducedView, IndustryProductionCost, IndustryProductionSnapshot } from '../../shared/industry-production'
import './industry-workspace.css'
import { IndustryProductionMarket } from './IndustryProductionMarket'
import { ProductionMarketQuoteQueue } from './industry-market-queue'

type ProductionApi = Pick<EveLocalIntelApi, 'getIndustryProduction' | 'saveIndustryProduction' | 'getAccountStatus'> & Partial<Pick<EveLocalIntelApi, 'compareMarketHubs'>>
const money = (n: number | null): string => n === null ? 'не подтверждено' : `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ISK`
export function IndustryProductionWorkspace({ api, active }: { api: ProductionApi | null; active: boolean }): React.JSX.Element {
  const [data, setData] = useState<IndustryProductionSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(50)
  const owner = useRef<number | null>(null)
  const sequence = useRef(0)
  const marketQueue = useMemo(() => api?.compareMarketHubs ? new ProductionMarketQuoteQueue(r => api.compareMarketHubs!(r)) : null, [api])
  const load = useCallback(async (forceRefresh = false): Promise<void> => {
    if (!api) return
    const seq = ++sequence.current
    setLoading(true); setError(null)
    try {
      const status = await api.getAccountStatus()
      if (seq !== sequence.current) return
      if (owner.current !== status.characterId) { owner.current = status.characterId; setData(null) }
      const result = await api.getIndustryProduction({ forceRefresh })
      if (seq === sequence.current && result.characterId === owner.current) setData(result)
    } catch (e) { if (seq === sequence.current) setError(e instanceof Error ? e.message : 'История недоступна') }
    finally { if (seq === sequence.current) setLoading(false) }
  }, [api])
  useEffect(() => {
    if (!active || !api) return
    void load()
    const timer = setInterval(() => void load(), 60000)
    let checking = false, disposed = false
    const identity = setInterval(() => {
      if (checking) return
      checking = true
      void api.getAccountStatus().then(s => { if (!disposed && s.characterId !== owner.current) { sequence.current++; owner.current = s.characterId; setData(null); void load() } }).catch(() => {}).finally(() => { checking = false })
    }, 2000)
    return () => { disposed = true; sequence.current++; clearInterval(timer); clearInterval(identity) }
  }, [api, active, load])
  const save = async (cost: IndustryProductionCost): Promise<void> => {
    if (!api) return
    const id = owner.current
    const result = await api.saveIndustryProduction(cost)
    if (id !== owner.current || result.characterId !== id) throw new Error('Персонаж изменился; обновите историю')
    setData(result)
  }
  const filtered = (data?.rows ?? []).filter(r => r.productName.toLowerCase().includes(query.toLowerCase()))
  return <section className="industry-shell" aria-labelledby="produced-title">
    <div className="workspace-hero"><div><p className="eyebrow">Реальные задания → автоматический расчёт → себестоимость</p><h1 id="produced-title">Готовая продукция</h1><p>Только ваши производственные задания со статусом «готово» или «забрано» в ESI. Купленные готовые товары из Hangar сюда не попадают.</p></div><button className="secondary-button" disabled={!api || loading} onClick={() => void load(true)}>Обновить задания и покупки</button></div>
    <div className="finance-panel"><p>Материалы и запуск подставляются автоматически. Введите только цену BPC и исходное число прогонов — без поиска ID контракта.</p><details><summary>Как считается себестоимость · допущения авторасчёта</summary><p>Расход — по рецепту и числу прогонов задания, с сохранённым ME чертежа; если ME неизвестен, используем ME 0. Бонусы материалов завода — базовые, без улучшений.</p>
      <p className="industry-warning">ESI не сообщает точный расход задания: это расчёт, не подтверждённое списание. Сначала используются ближайшие покупки до запуска, без повторного списания одной сделки. Если количества в истории не хватает — оценка по последней цене покупки; если покупок нет — текущий SELL Jita. Источник виден у каждого материала. Неизвестные цены — не ноль.</p>
      <p>Запуск и налоги — фактически списанная сумма ESI, без второй комиссии сверху. Если суммы нет: оценка по текущему SCI Jita + базовые допущения 0,25% налога завода и 4% SCC от EIV, Omega. Цена BPC вводится вручную; для того же экземпляра запоминается между заданиями.</p>
      <p>BPC распределяется по использованным прогонам, остаток остаётся активом. BPO не расходуется. Налог будущей продажи не входит в себестоимость производства. Список — история выпуска, не текущий остаток после продаж или перевозок. Задания сохраняются фоном раз в 5 минут, пока Fly Safe запущен и есть вход EVE SSO.</p>
      </details><div className="industry-fields"><label>Найти произведённый товар<input value={query} onChange={e => setQuery(e.target.value)} /></label></div></div>
    {error && <p className="industry-negative" role="alert">{error}</p>}
    {loading && <p role="status">Обновляю производственную историю…</p>}
    {data?.warnings.map(w => <p key={w} className="industry-warning">{w}</p>)}
    <div className="industry-opportunities">{filtered.slice(0, limit).map(row => <IndustryProducedCard key={`${data!.characterId}_${row.job.jobId}`} row={row} snapshot={data!} onSave={save} marketQueue={marketQueue} active={active} />)}</div>
    {!loading && data && filtered.length === 0 && (data.rows.length > 0 ? <p>По запросу «{query}» ничего не найдено. Всего готовых заданий: {data.rows.length}. <button className="secondary-button" onClick={() => setQuery('')}>Сбросить поиск</button></p> : <p>Готовых производственных заданий пока нет. Обновите данные; ESI возвращает ограниченную историю. Сохранённые приложением задания останутся в базе.</p>)}
    {filtered.length > limit && <button className="secondary-button" onClick={() => setLimit(v => v + 50)}>Показать ещё 50 заданий</button>}
  </section>
}
export function IndustryProducedCard({ row, snapshot, onSave, marketQueue = null, active = true }: { row: IndustryProducedView; snapshot: IndustryProductionSnapshot; onSave(cost: IndustryProductionCost): Promise<void>; marketQueue?: ProductionMarketQuoteQueue | null; active?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return <article className="industry-opportunity industry-produced"><header><div><h3>{row.productName} · {row.outputQuantity.toLocaleString('ru-RU')} шт.</h3><span>Задание #{row.job.jobId} · {row.job.runs} прогонов · {row.job.status === 'delivered' ? 'забрано' : 'готово, ещё не забрано'} · {new Date(row.job.endDate).toLocaleString('ru-RU')}</span></div><strong>{money(row.unitCost)}<small>{row.cost?.materialsConfirmed && row.job.cost !== null ? 'Себестоимость 1 шт.' : 'Расчётная себестоимость 1 шт.'}</small></strong></header>
    <div className="industry-buy-metrics"><div><small>{row.cost?.materialsConfirmed ? 'Материалы · подтверждено ранее' : 'Материалы · авторасчёт'}</small><strong>{money(row.materialCost)}</strong></div><div><small>Расход BPC</small><strong>{money(row.blueprintCost)}</strong></div><div><small>{row.automatic?.jobCostSource === 'jita-estimate' ? 'Запуск · оценка Jita' : 'Запуск и налоги ESI'}</small><strong>{money(row.job.cost ?? row.automatic?.jobCost ?? null)}</strong></div></div>
    <p>Вся партия: <strong>{money(row.totalCost)}</strong>{row.cost?.extraCost ? ` · ранее записанные дополнительные расходы ${money(row.cost.extraCost)}` : ''}</p>
    <IndustryProductionMarket row={row} queue={marketQueue} active={active} salesTaxPercent={snapshot.salesTaxPercent} salesTaxSource={snapshot.salesTaxSource} />
    {row.missing.map(m => <p key={m} className="industry-warning">{m}</p>)}
    {row.automatic && <details className="industry-plan-details"><summary>Материалы и источники цен · {row.cost?.materialsConfirmed ? 'подтверждено ранее' : 'расчётный расход'}</summary><div className="industry-ledger-scroll"><table><thead><tr><th>Материал</th><th>Израсходовано по расчёту</th><th>Цена за единицу</th><th>Всего</th><th>Источник</th></tr></thead><tbody>{row.automatic.materials.map(m => <tr key={m.typeId}><td>{m.name}</td><td>{m.quantity?.toLocaleString('ru-RU') ?? 'неизвестно'}</td><td>{money(m.total !== null && m.quantity ? m.total / m.quantity : null)}</td><td>{money(m.total)}</td><td>{m.source === 'purchases' ? 'Покупки до запуска' : m.source === 'purchase-estimate' ? 'Оценка по последней покупке' : m.source === 'jita-sell' ? 'Текущий SELL Jita · оценка' : 'Цена неизвестна'}{m.pricedAt && <small>{new Date(m.pricedAt).toLocaleString('ru-RU')}</small>}</td></tr>)}</tbody></table></div>{row.automatic.assumptions.map(a => <p className="industry-warning" key={a}>{a}</p>)}</details>}
    <details className="industry-plan-details" onToggle={e => setOpen(e.currentTarget.open)}><summary>{row.cost?.blueprint ? 'Изменить стоимость BPC / BPO' : 'Указать только стоимость BPC'}</summary>{open && <ProductionCostEditor key={row.cost?.updatedAt ?? 'new'} row={row} onSave={onSave} />}</details>
  </article>
}
export function ProductionCostEditor({ row, onSave }: { row: IndustryProducedView; onSave(cost: IndustryProductionCost): Promise<void> }): React.JSX.Element {
  const [draft, setDraft] = useState<IndustryProductionCost>(() => ({ jobId: row.job.jobId, allocations: row.cost?.allocations ?? [], materialsConfirmed: row.cost?.materialsConfirmed ?? false, blueprint: row.cost?.blueprint ?? null, extraCost: row.cost?.extraCost ?? 0 }))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [priceEntered, setPriceEntered] = useState(row.cost?.blueprint !== null && row.cost?.blueprint !== undefined)
  const blueprint = draft.blueprint
  const editBlueprint = (patch: Partial<NonNullable<IndustryProductionCost['blueprint']>>): void => setDraft({ ...draft, blueprint: { kind: 'copy', contractId: null, purchasePrice: 0, runsPurchased: row.job.runs, ...blueprint, ...patch } })
  const submit = async (): Promise<void> => {
    if ((draft.blueprint?.kind ?? 'copy') === 'copy' && !priceEntered) { setError('Введите оплаченную цену BPC'); return }
    setSaving(true); setError(null)
    try { await onSave(draft) } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить') } finally { setSaving(false) }
  }
  return <div className="industry-production-editor"><p>Материалы, количество и запуск уже рассчитаны. ID контракта не нужен.</p>
    <div className="industry-fields"><label>Чертёж<select value={blueprint?.kind ?? 'copy'} onChange={e => editBlueprint({ kind: e.target.value as 'copy' | 'original' })}><option value="copy">BPC · копия</option><option value="original">BPO · оригинал</option></select></label>
      {(blueprint?.kind ?? 'copy') === 'copy' && <><label>Фактически оплачено за BPC, ISK<input aria-label="Цена BPC" type="number" min={0} value={priceEntered ? blueprint?.purchasePrice ?? '' : ''} onChange={e => { setPriceEntered(e.target.value !== ''); editBlueprint({ purchasePrice: Number(e.target.value) }) }} /></label><label>Исходное число прогонов в BPC<input aria-label="Прогоны BPC" type="number" min={row.job.runs} value={blueprint?.runsPurchased ?? row.job.runs} onChange={e => editBlueprint({ runsPurchased: Number(e.target.value) })} /></label></>}
    </div><p>Цена запоминается для этого экземпляра чертежа. На задание списывается цена BPC / исходные прогоны × {row.job.runs} прогонов задания. Если покупали пакет чертежей — укажите долю цены этого BPC.</p>
    {error && <p role="alert" className="industry-negative">{error}</p>}<button className="primary-button" disabled={saving} onClick={() => void submit()}>{saving ? 'Сохраняю…' : 'Сохранить стоимость чертежа'}</button>
  </div>
}
