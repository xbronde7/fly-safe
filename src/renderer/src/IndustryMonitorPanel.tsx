import { useEffect, useState } from 'react'
import { DEFAULT_INDUSTRY_MONITOR, type IndustryMonitorConfig, type IndustryMonitorSnapshot, type IndustryMonitorDeal } from '../../shared/industry-monitor'
import type { IndustryScanRequest } from '../../shared/industry'

export interface IndustryMonitorApi {
  getIndustryMonitor?(): Promise<IndustryMonitorSnapshot>
  configureIndustryMonitor?(request: IndustryMonitorConfig): Promise<IndustryMonitorSnapshot>
}
const money = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ISK`
export function IndustryMonitorPanel({ api, active, request }: { api: IndustryMonitorApi | null; active: boolean; request: IndustryScanRequest }): React.JSX.Element {
  const [state, setState] = useState<IndustryMonitorSnapshot | null>(null)
  const [draft, setDraft] = useState<IndustryMonitorConfig>(DEFAULT_INDUSTRY_MONITOR)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [owner, setOwner] = useState<number | null>(null)
  useEffect(() => {
    if (!active || !api?.getIndustryMonitor) return
    let disposed = false, pending = false
    const load = async (): Promise<void> => {
      if (pending) return
      pending = true
      try {
        const data = await api.getIndustryMonitor!()
        if (disposed) return
        setState(data)
        setError(null)
        if (data.characterId !== owner || state === null) { setDraft(data.config); setOwner(data.characterId) }
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : 'Монитор недоступен') }
      finally { pending = false }
    }
    void load(); const timer = setInterval(() => void load(), 5000)
    return () => { disposed = true; clearInterval(timer) }
  }, [api, active, owner, state === null])
  const save = async (config: IndustryMonitorConfig): Promise<void> => {
    if (!api?.configureIndustryMonitor) return
    setSaving(true); setError(null)
    try { const data = await api.configureIndustryMonitor(config); setState(data); setDraft(data.config) }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить монитор') }
    finally { setSaving(false) }
  }
  return <section className="finance-panel industry-monitor" aria-label="Монитор дешёвых BPC">
    <h2>Монитор дешёвых BPC</h2>
    <p>Быстрые сделки · 1 прогон. Только покупка BPC из публичных контрактов + закупка всех ресурсов по SELL + продажа результата в BUY. Свои чертежи и запасы исключены. Массовый план на 9 линий ниже — отдельный поиск.</p>
    <div className="industry-actions"><button className={state?.config.enabled ? 'secondary-button' : 'primary-button'} disabled={saving || !state?.characterId} onClick={() => void save({ ...(state?.config ?? draft), enabled: !state?.config.enabled })}>{state?.config.enabled ? 'Выключить монитор' : 'Включить монитор'}</button>
      <strong role="status">{state?.message ?? 'Монитор выключен'}</strong></div>
    {error && <p className="industry-negative" role="alert">{error}</p>}
    {state?.error && <p className="industry-negative">{state.error}</p>}
    <p>Последний завершённый проход: {state?.lastCompleted ? new Date(state.lastCompleted).toLocaleString('ru-RU') : 'ещё нет'} · следующий: {state?.nextCheck ? new Date(state.nextCheck).toLocaleTimeString('ru-RU') : state?.running ? 'после текущего' : '—'}</p>
    <details><summary>Пороги уведомлений и настройки монитора</summary>
      <div className="industry-fields">
        <label>Минимум прибыли 1 прогона, ISK<input type="number" min={0} value={draft.minimumProfit} onChange={e => setDraft({ ...draft, minimumProfit: Number(e.target.value) })} /></label>
        <label>Минимум прибыль / вся закупка, %<input type="number" min={0} value={draft.minimumMargin} onChange={e => setDraft({ ...draft, minimumMargin: Number(e.target.value) })} /></label>
        <label>Бюджет, ISK · 0 = без лимита<input type="number" min={0} value={draft.budget} onChange={e => setDraft({ ...draft, budget: Number(e.target.value) })} /></label>
        <label>Интервал после прохода, минут<input type="number" min={5} max={1440} value={draft.intervalMinutes} onChange={e => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })} /></label>
      </div>
      <label className="industry-check"><input type="checkbox" checked={draft.notifications} onChange={e => setDraft({ ...draft, notifications: e.target.checked })} />Уведомлять о супервыгодных сделках</label>
      <p>Закупка {draft.request.buyHubId} · продажа {draft.request.sellHubId} · производство {draft.request.productionSystem}. Контракты: {draft.request.blueprintHubIds.join(', ')}.</p>
      <div className="industry-actions"><button className="secondary-button" onClick={() => setDraft({ ...draft, request: { ...request, scanId: 'monitor', blueprintMode: 'contracts', contractCopiesOnly: true, blueprintHubIds: draft.request.blueprintHubIds, productionQuantity: undefined, stockLocationId: undefined, massProduction: undefined, autoPlan: false, runs: 1 } })}>Взять хабы, завод и налоги из расчёта ниже</button>
        <button className="secondary-button" disabled={saving || !state?.characterId} onClick={() => void save({ ...draft, enabled: state?.config.enabled ?? false })}>Сохранить настройки монитора</button></div>
    </details>
    <details><summary>Как работает фон, регионы и ограничения ESI</summary><p className="industry-warning">Работает, пока запущен Fly Safe, даже в другом разделе или со свёрнутым окном. После выхода из EVE SSO ждёт входа. Проверяются все производственные типы BPC в 5 регионах хабов, не все регионы New Eden. Первый индекс может занять долгое время. Контракты ESI кешируются до 30 минут, рынок — около 5: мгновенный перехват ошибочной цены не гарантирован.</p>
    <small>Уведомления также должны быть включены в Settings и разрешены системой. Повтор одного контракта подавляется между запусками; не более 5 новых уведомлений за проход. Найденное не бронируется и ничего не покупается автоматически.</small></details>
    <div className="industry-opportunities">{state?.deals.map(deal => <IndustryMonitorDealCard key={deal.contractId} deal={deal} />)}</div>
    {state && !state.running && state.config.enabled && state.deals.length === 0 && <p>Подтверждённых прибыльных BUY-партий пока нет. Пороги выше влияют на уведомления, не скрывают остальные прибыльные сделки.</p>}
  </section>
}
export function IndustryMonitorDealCard({ deal }: { deal: IndustryMonitorDeal }): React.JSX.Element {
  return <article className="industry-opportunity"><header><div><h3>{deal.productName}</h3><span>Контракт #{deal.contractId} · {deal.row.blueprint.systemName ?? deal.row.blueprint.locationId} · {deal.runs} прогонов → {deal.quantity} шт.</span></div><strong className="industry-positive">+{money(deal.profit)}<small>{deal.exceptional ? 'Порог супервыгодной сделки достигнут' : 'Прибыльная BUY-партия'}</small></strong></header>
    <p>BPC: {money(deal.contractPrice)} · вся закупка: {money(deal.capital)} · доходность: {deal.margin.toFixed(1)}% · {money(deal.hourly)} / ч.</p>
    <small>Рынок: {new Date(deal.marketAt).toLocaleString('ru-RU')}. BUY может измениться до окончания производства. Проверьте доступность контракта и доставку до оплаты.</small>
    <details><summary>Материалы и расчёт выбранной партии</summary><p>ME {deal.row.blueprint.me} / TE {deal.row.blueprint.te} · {deal.row.hours.toFixed(2)} ч. · ресурсы {money(deal.row.materialCost!)} · запуск {money(deal.row.installationCost!)} · расход BPC {money(deal.row.blueprint.cost!)} · налог продажи {money(deal.row.salesTax!)}.</p>
      {deal.row.materials.map(m => <p key={m.typeId}>{m.name} × {m.quantity.toLocaleString('ru-RU')} · {money(m.fill.total)}</p>)}</details>
  </article>
}
