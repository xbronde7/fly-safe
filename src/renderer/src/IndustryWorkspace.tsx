import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MARKET_HUBS, type MarketHubId } from '../../shared/market'
import {
  INDUSTRY_SCOPES, industrySkillLevels, industrySlots, industrySalesTaxPercent, jobReadyToDeliver, industrySalesView,
  type IndustryCharacterSnapshot, type IndustryJob, type IndustryOpportunity,
  type IndustryScanProgress, type IndustryScanRequest, type IndustryScanResult, type IndustryFactoryRequest, type IndustryFactoryResult, type IndustryFactoryQuote, type IndustryLiquidityRequest, type IndustryLiquidity
} from '../../shared/industry'
import type { EveAccountStatus, EveMultiAccountStatus } from '../../shared/types'
import { industryPurchaseBasis, industryPurchaseQuote, industryMaterialCostView, type IndustryMaterialCostMode, type IndustryLedgerSnapshot, type PurchaseBasis } from '../../shared/industry-ledger'
import { IndustryPurchaseJournal } from './IndustryPurchaseJournal'
import { IndustryMonitorPanel, type IndustryMonitorApi } from './IndustryMonitorPanel'
import { industryBuyDecision, type IndustryBuyDecision } from '../../shared/industry-decision'
import { DEFAULT_MASS_SETTINGS, industryMassReasons, massJobCashProfit } from '../../shared/industry-mass'
import { IndustryMassPanel, IndustryMassJobCard } from './IndustryMassPanel'
import './industry-workspace.css'

interface IndustryApi extends IndustryMonitorApi {
  getIndustryLedger(request?: { forceRefresh?: boolean }): Promise<IndustryLedgerSnapshot>
  getIndustryCharacter(request?: { forceRefresh?: boolean }): Promise<IndustryCharacterSnapshot>
  scanIndustry(request: IndustryScanRequest): Promise<IndustryScanResult>
  getIndustryFactories(request: IndustryFactoryRequest): Promise<IndustryFactoryResult>
  getIndustryLiquidity?(request: IndustryLiquidityRequest): Promise<IndustryLiquidity[]>
  cancelIndustryScan(): Promise<void>
  onIndustryProgress(callback: (progress: IndustryScanProgress) => void): () => void
  getAccountStatus(): Promise<EveAccountStatus>
  connectIndustryCharacter(): Promise<EveMultiAccountStatus>
}
const DEFAULT_REQUEST: IndustryScanRequest = {
  scanId: 'initial', buyHubId: 'jita', sellHubId: 'jita', blueprintHubIds: ['jita'], blueprintMode: 'combined',
  runs: 1, productionSystem: 'Jita', facilityTaxPercent: 0.25, sccPercent: 4,
  materialReductionPercent: 0, timeReductionPercent: 0, jobCostReductionPercent: 0,
  clone: 'omega', transportCost: 0, autoPlan: false, salesMode: 'buy', brokerFeePercent: 3, massProduction: DEFAULT_MASS_SETTINGS
}
export function IndustryWorkspace({ api, active }: { api: IndustryApi | null; active: boolean }): React.JSX.Element {
  const [character, setCharacter] = useState<IndustryCharacterSnapshot | null>(null)
  const [ledger, setLedger] = useState<IndustryLedgerSnapshot | null>(null)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [ledgerError, setLedgerError] = useState<string | null>(null)
  const [purchaseSince, setPurchaseSince] = useState(() => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
  const [materialMode, setMaterialMode] = useState<IndustryMaterialCostMode>('market')
  const [settings, setSettings] = useState(DEFAULT_REQUEST)
  const [allBlueprintRegions, setAllBlueprintRegions] = useState(false)
  const [loadingCharacter, setLoadingCharacter] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<IndustryScanResult | null>(null)
  const [historyHub, setHistoryHub] = useState<MarketHubId | null>(null)
  const [rows, setRows] = useState<IndustryOpportunity[]>([])
  const [progress, setProgress] = useState<IndustryScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'profit' | 'hour' | 'margin'>('profit')
  const basis = 'first' as const
  const [liquidity, setLiquidity] = useState<Record<number, IndustryLiquidity | null>>({})
  const [liquidityRevision, setLiquidityRevision] = useState(0)
  const [minimumDaily, setMinimumDaily] = useState(0)
  const [onlyProfitable, setOnlyProfitable] = useState(true)
  const [onlyReady, setOnlyReady] = useState(true)
  const [budget, setBudget] = useState(0)
  const [minimumProfit, setMinimumProfit] = useState(0)
  const [stockLocation, setStockLocation] = useState('60003760')
  const [visibleCount, setVisibleCount] = useState(100)
  const [clock, setClock] = useState(Date.now())
  const [factoryBlueprint, setFactoryBlueprint] = useState<number | null>(null)
  const [selectedFactory, setSelectedFactory] = useState<string | null>(null)
  const scanId = useRef<string | null>(null)
  const characterId = useRef<number | null>(null)
  const loadSequence = useRef(0)
  const ledgerSequence = useRef(0)
  const scanningRef = useRef(false)
  const factoriesPanel = useRef<HTMLDivElement | null>(null)
  useEffect(() => { factoriesPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, [factoryBlueprint])

  const loadCharacter = useCallback(async (forceRefresh = false): Promise<void> => {
    if (!api) return
    const sequence = ++loadSequence.current
    setLoadingCharacter(true)
    try {
      const data = await api.getIndustryCharacter({ forceRefresh })
      if (sequence !== loadSequence.current) return
      if (characterId.current !== data.characterId) { setResult(null); setRows([]); setLedger(null); setLedgerError(null); setHistoryHub(null); setLiquidity({}); scanId.current = null }
      characterId.current = data.characterId
      setCharacter(data)
    } catch (caught) {
      if (sequence === loadSequence.current) setError(messageOf(caught))
    } finally { if (sequence === loadSequence.current) setLoadingCharacter(false) }
  }, [api])

  useEffect(() => {
    if (!active || !api) return
    void loadCharacter()
    const refresh = setInterval(() => { if (!scanningRef.current) void loadCharacter() }, 60_000)
    const timer = setInterval(() => setClock(Date.now()), 1000)
    let disposed = false
    const identity = setInterval(() => {
      void api.getAccountStatus().then(status => {
        if (disposed || status.characterId === characterId.current) return
        characterId.current = status.characterId
        loadSequence.current += 1; scanId.current = null
        setCharacter(null); setRows([]); setResult(null); setProgress(null); setLedger(null); setLedgerError(null); setHistoryHub(null); setLiquidity({})
        if (status.characterId !== null) void loadCharacter()
      }).catch(() => undefined)
    }, 2000)
    return () => { disposed = true; loadSequence.current += 1; clearInterval(refresh); clearInterval(timer); clearInterval(identity) }
  }, [active, api, loadCharacter])
  useEffect(() => {
    if (!api) return
    return api.onIndustryProgress(event => {
      if (event.scanId !== scanId.current || event.characterId !== characterId.current) return
      setProgress(event)
      if (event.rows) setRows(current => [...new Map([...current, ...event.rows!].map(row => [row.blueprintTypeId, row])).values()])
    })
  }, [api])
  const scan = async (forceRefresh: boolean): Promise<void> => {
    if (!api || !character?.skills) return
    const id = `industry_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    scanId.current = id; scanningRef.current = true
    setHistoryHub(settings.sellHubId); setLiquidity({}); setLiquidityRevision(v => v + 1)
    setScanning(true); setError(null); setResult(null); setRows([]); setProgress(null)
    try {
      const data = await api.scanIndustry({ ...settings, scanId: id, forceRefresh,
        massProduction: { ...settings.massProduction!, budget }, stockLocationId: undefined,
        blueprintHubIds: allBlueprintRegions ? MARKET_HUBS.map(h => h.id) : [settings.buyHubId] })
      if (scanId.current === id && data.characterId === characterId.current) { setResult(data); setRows(data.rows); if (data.massPlan) setLiquidity(current => ({ ...current, ...Object.fromEntries(data.massPlan!.liquidity.map(h => [h.typeId, h])) })) }
    } catch (caught) {
      if (scanId.current === id) {
        const message = messageOf(caught)
        setError(message)
        setProgress(current => current ? { ...current, message: 'Сканирование не завершено · результаты предварительные, минимум цены не подтверждён' } : null)
        if (message.includes('Персонаж изменился')) setRows([])
      }
    } finally { scanningRef.current = false; setScanning(false) }
  }
  const edit = <K extends keyof IndustryScanRequest>(key: K, value: IndustryScanRequest[K]): void => setSettings(current => ({ ...current, [key]: value }))
  const connectIndustry = async (): Promise<void> => {
    if (!api) return
    setConnecting(true); setError(null)
    try { await api.connectIndustryCharacter(); await loadCharacter(true) }
    catch (caught) { setError(messageOf(caught)) }
    finally { setConnecting(false) }
  }
  const loadLedger = useCallback(async (forceRefresh = false): Promise<void> => {
    const id = character?.characterId
    if (!api || !id) return
    const sequence = ++ledgerSequence.current
    setLedgerLoading(true)
    try {
      const data = await api.getIndustryLedger({ forceRefresh })
      if (sequence === ledgerSequence.current && characterId.current === id && data.characterId === id) { setLedger(data); setLedgerError(null) }
    } catch {
      if (sequence === ledgerSequence.current && characterId.current === id) setLedgerError('Не удалось обновить покупки. Проверьте вход EVE SSO и повторите обновление.')
    } finally { if (sequence === ledgerSequence.current && characterId.current === id) setLedgerLoading(false) }
  }, [api, character?.characterId])
  useEffect(() => {
    if (!active || !character?.characterId) return
    void loadLedger()
    const timer = setInterval(() => void loadLedger(), 60_000)
    return () => { clearInterval(timer); ledgerSequence.current++ }
  }, [active, character?.characterId, loadLedger])
  const purchases = useMemo(() => ledger && ledger.characterId === character?.characterId ? industryPurchaseBasis(ledger.transactions, purchaseSince) : undefined, [ledger, character?.characterId, purchaseSince])
  const salesRows = useMemo(() => rows.map(row => industryMaterialCostView(industrySalesView(row, settings.salesMode ?? 'buy', settings.brokerFeePercent ?? 3), purchases ?? new Map(), materialMode, Number(stockLocation))), [rows, settings.salesMode, settings.brokerFeePercent, purchases, materialMode, stockLocation])
  const massSettings = result?.request.massProduction ?? settings.massProduction!
  const filtered = useMemo(() => {
    return salesRows.filter(row => {
    const profit = massJobCashProfit(row), ready = industryMassReasons(row, { ...massSettings, budget }).length === 0
    return row.productName.toLowerCase().includes(query.toLowerCase()) && (!onlyReady || ready) &&
      (!onlyProfitable || profit !== null && profit > 0) && (minimumProfit <= 0 || profit !== null && profit >= minimumProfit) &&
      (budget <= 0 || row.capitalRequired !== null && row.capitalRequired <= budget)
  }).sort((a, b) => {
    const score = (row: IndustryOpportunity): number => {
      const cash = massJobCashProfit(row)
      return (cash === null ? null : sort === 'hour' ? cash / row.hours : sort === 'margin' ? row.capitalRequired! > 0 ? cash / row.capitalRequired! * 100 : null : cash) ?? -Infinity
    }
    return score(b) - score(a) || a.productName.localeCompare(b.productName)
  }) }, [salesRows, query, onlyReady, onlyProfitable, budget, minimumProfit, sort, massSettings])
  // Load visible history before applying its demand filter, otherwise unknown rows
  // would disappear before their first history request could be scheduled.
  const liquidityTypes = filtered.slice(0, visibleCount).map(r => r.productTypeId).join(',')
  useEffect(() => {
    if (!api?.getIndustryLiquidity || !historyHub || !liquidityTypes) return
    let cancelled = false
    const ids = [...new Set(liquidityTypes.split(',').map(Number))].filter(id => liquidity[id] === undefined)
    void (async () => {
      for (let i = 0; i < ids.length && !cancelled; i += 25) {
        const batch = ids.slice(i, i + 25)
        try {
          const data = await api.getIndustryLiquidity!({ hubId: historyHub, typeIds: batch })
          if (!cancelled) setLiquidity(current => ({ ...current, ...Object.fromEntries(batch.map(id => [id, data.find(r => r.typeId === id) ?? null])) }))
        } catch {
          if (!cancelled) setLiquidity(current => ({ ...current, ...Object.fromEntries(batch.map(id => [id, null])) }))
        }
      }
    })()
    return () => { cancelled = true }
    // Cache changes must not cancel this bounded queue after each completed chunk.
  }, [api, historyHub, liquidityTypes, liquidityRevision])
  const displayed = filtered.slice(0, visibleCount).filter(row => minimumDaily <= 0 || liquidity[row.productTypeId] && !liquidity[row.productTypeId]!.stale && liquidity[row.productTypeId]!.daily30 >= minimumDaily)
  const levels = character?.skills ? industrySkillLevels(character.skills) : null
  const settingsChanged = result !== null && ((['buyHubId', 'sellHubId', 'blueprintMode', 'productionSystem', 'facilityTaxPercent', 'sccPercent', 'materialReductionPercent', 'timeReductionPercent', 'jobCostReductionPercent', 'clone', 'transportCost', 'brokerFeePercent'] as const).some(key => settings[key] !== result.request[key]) || JSON.stringify({ ...settings.massProduction!, budget }) !== JSON.stringify(result.request.massProduction) || JSON.stringify(allBlueprintRegions ? MARKET_HUBS.map(h => h.id) : [settings.buyHubId]) !== JSON.stringify(result.request.blueprintHubIds))
  const resetFilters = (): void => { setOnlyProfitable(false); setOnlyReady(false); setBudget(0); setMinimumProfit(0); setMinimumDaily(0); setQuery(''); setVisibleCount(100) }
  const jobs = (character?.jobs ?? []).filter(j => j.activityId === 1 && ['active', 'paused', 'ready'].includes(j.status))
  const busySlots = jobs.filter(j => !jobReadyToDeliver(j, clock)).length
  return <section className="industry-shell" aria-labelledby="industry-title">
    <div className="workspace-hero"><div><p className="eyebrow">Чертёж → ресурсы по SELL → производство → продажа</p><h1 id="industry-title">Производство</h1>
      <p>Поиск прибыли — массовое производство на 9 линиях. Монитор сверху — быстрые сделки на 1 прогон. Покупка, запуск и продажа — вручную в EVE.</p></div>
      <button className="secondary-button" disabled={!api || loadingCharacter || scanning} onClick={() => void loadCharacter(true)}>Обновить персонажа</button></div>
    {error && <div className="workspace-inline-error" role="alert">{error}</div>}
    <IndustryMonitorPanel api={api} active={active} request={settings} />
    {loadingCharacter && !character && <p role="status">Загружаю навыки и задания…</p>}
    {character && <div className="industry-character"><strong>{character.characterName}</strong>
      <span>Industry {levels?.get(3380) ?? '—'} · Advanced Industry {levels?.get(3388) ?? '—'} · Accounting {levels?.get(16622) ?? '—'}</span>
      <span>Налог продажи: {levels ? `${industrySalesTaxPercent(levels).toFixed(3)}%` : 'неизвестен'}</span>
      <span>Слоты: {character.skills && character.jobs ? `${busySlots}/${industrySlots(character.skills)} занято` : 'неизвестны'}</span>
      <small>Проверено {new Date(character.fetchedAt).toLocaleTimeString('ru-RU')}; задания ESI кешируются до 5 минут.</small></div>}
    {character && (character.missingScopes.length > 0 || character.warnings.length > 0) && <div className="scope-warning" role="status">
      {character.missingScopes.length > 0 && <><strong>Нужны дополнительные разрешения EVE SSO</strong><p>Нажмите кнопку и выберите нужного персонажа в EVE SSO. Если CCP сообщает invalid_scope, владелец OAuth-приложения Fly Safe должен сначала включить эти scopes в EVE Developers. Обычный вход продолжает работать.</p><code>{character.missingScopes.join(' · ')}</code><button className="secondary-button" disabled={connecting || scanning} onClick={() => void connectIndustry()}>{connecting ? 'Ожидаю вход EVE SSO…' : 'Подключить разрешения производства'}</button></>}
      {character.warnings.map(w => <p key={w}>{w}</p>)}</div>}
    <details className="finance-panel industry-jobs"><summary>Текущее производство · {jobs.length} заданий{jobs.filter(j => jobReadyToDeliver(j, clock)).length > 0 ? ` · готово ${jobs.filter(j => jobReadyToDeliver(j, clock)).length}` : ''}</summary>
      <p>Автообновление при открытом разделе: раз в минуту. Таймер не заменяет подтверждение ESI; готовые задания забираются в игре.</p>
      {!character ? <p>Подключите персонажа для мониторинга.</p> : character.jobs === null ? <p>Задания недоступны: нужно разрешение <code>{INDUSTRY_SCOPES.jobs}</code>, либо ESI не ответил.</p> : jobs.length === 0 ? <p>Нет загруженных производственных заданий.</p> : jobs.map(job => <IndustryJobCard key={job.jobId} job={job} now={clock} />)}</details>
    {character && <IndustryPurchaseJournal key={character.characterId} ledger={ledger?.characterId === character.characterId ? ledger : null} loading={ledgerLoading} error={ledgerError} since={purchaseSince} onSince={setPurchaseSince} onRefresh={() => void loadLedger(true)} />}
    <div className="industry-settings finance-panel"><div className="industry-fields">
      <HubField label="Закупка материалов" value={settings.buyHubId} onChange={v => edit('buyHubId', v)} />
      <HubField label="Хаб продажи" value={settings.sellHubId} onChange={v => edit('sellHubId', v)} />
      <label>Стоимость материалов<select disabled value={materialMode} onChange={e => setMaterialMode(e.target.value as IndustryMaterialCostMode)}><option value="market">Только рынок · купить всё по SELL</option><option value="mixed">Свои запасы + докупить с рынка</option><option value="purchases">Только цены из истории покупок</option></select></label>
      <label>Система производства<input value={settings.productionSystem} maxLength={80} onChange={e => { edit('productionSystem', e.target.value); setSelectedFactory(null) }} /></label>
      <label>Клон<select value={settings.clone} onChange={e => edit('clone', e.target.value as 'omega' | 'alpha')}><option value="omega">Omega · задано вручную</option><option value="alpha">Alpha · +0.25% EIV</option></select></label></div>
      <h2>Массовый поиск прибыли</h2><p>Чертежи объединены: База публичных контрактов + рынок BPO + доступные свои BPO. Свои BPC без оплаченной цены и пакетные контракты в общий план не входят. Материалы — только новая закупка с рынка. Количество задавать не нужно: подбираем длинные партии, не выгодный одиночный прогон. BUY · продать сразу — основной расчёт, SELL · выставить ордер — оценка.</p>
      <div className="industry-fields">
        <NumberField label="Производственных линий" value={settings.massProduction!.lines} min={1} max={11} onChange={v => edit('massProduction', { ...settings.massProduction!, lines: v })} />
        <NumberField label="Цикл производства, часов" value={settings.massProduction!.hours} min={1} max={720} onChange={v => edit('massProduction', { ...settings.massProduction!, hours: v })} />
        <NumberField label="Минимум часов на одно задание" value={settings.massProduction!.minimumHours} min={0.1} max={720} onChange={v => edit('massProduction', { ...settings.massProduction!, minimumHours: v })} />
        <NumberField label="Минимум прогонов на задание" value={settings.massProduction!.minimumRuns} min={2} max={100000} onChange={v => edit('massProduction', { ...settings.massProduction!, minimumRuns: v })} />
        <NumberField label="Максимум доли суточного спроса, %" value={settings.massProduction!.maximumDailySharePercent} min={1} max={100} onChange={v => edit('massProduction', { ...settings.massProduction!, maximumDailySharePercent: v })} />
      </div><p>По умолчанию: 9 линий, цикл 24 ч., задания от 4 ч. и 2 прогонов. Прибыль — после покупки всего контракта / BPO, не только списания пары прогонов. Общий бюджет задаётся ниже и применяется ко всем линиям вместе при новом поиске.</p>
      {materialMode !== 'market' && <><label>Цены ваших покупок начиная с · UTC<input type="date" value={purchaseSince} onChange={e => setPurchaseSince(e.target.value)} /></label><p>Смешанный режим: реальные запасы выбранного Hangar по средним ценам покупок; без истории — рыночная оценка. Недостающее докупается по глубине sell-ордеров. История покупок сама по себе не означает наличие запасов.</p></>}
      <details><summary>Справка о запасах · массовый план их не вычитает</summary><div className="industry-fields"><label>ID станции / структуры с запасами<input inputMode="numeric" value={stockLocation} onChange={e => setStockLocation(e.target.value)} /></label>
        <label className="industry-check"><input type="checkbox" disabled checked={false} readOnly />Свои запасы не вычитаются из массовой закупки</label></div>
      <p>Общий массовый план закупает весь рецепт по SELL; запасы и история покупок не уменьшают его бюджет.</p></details>
      {selectedFactory && <p className="industry-warning">Выбрано: {selectedFactory}. Параметры NPC применены. Нажмите «Найти прибыль», чтобы пересчитать все чертежи.</p>}
      <label className="industry-check"><input type="checkbox" checked={allBlueprintRegions} onChange={e => setAllBlueprintRegions(e.target.checked)} />Чертежи во всех 5 регионах хабов (дольше при первой загрузке)</label>
      <p>Первый проход публичных контрактов может быть долгим; их содержимое сохраняется. Рынок и свои чертежи показываются сразу, затем добавляются контрактные варианты. После долгой индексации рынок обновляется заново. Массовый план исключает пакеты, аукционы и обмены с требуемыми предметами.</p>
      <details><summary>Налоги фабрики, бонусы и перевозка</summary><div className="industry-fields">
        <NumberField label="Брокерская комиссия SELL, % · вручную" value={settings.brokerFeePercent ?? 3} max={10} onChange={v => edit('brokerFeePercent', v)} />
        <NumberField label="Налог фабрики, % EIV" value={settings.facilityTaxPercent} max={10} onChange={v => edit('facilityTaxPercent', v)} />
        <NumberField label="SCC, % EIV" value={settings.sccPercent} max={100} onChange={v => edit('sccPercent', v)} />
        <NumberField label="Снижение материалов сооружением / ригами, %" value={settings.materialReductionPercent} max={90} onChange={v => edit('materialReductionPercent', v)} />
        <NumberField label="Снижение времени фабрикой / имплантами, %" value={settings.timeReductionPercent} max={90} onChange={v => edit('timeReductionPercent', v)} />
        <NumberField label="Снижение SCI-составляющей стоимости, %" value={settings.jobCostReductionPercent} max={90} onChange={v => edit('jobCostReductionPercent', v)} />
        <NumberField label="Доставка на всю партию, ISK" value={settings.transportCost} max={1e15} onChange={v => edit('transportCost', v)} /></div>
        <p>По умолчанию: NPC-подобный налог 0.25%, SCC 4%, бонусы 0%, доставка 0 ISK. API не подтверждает фабрику, её тарифы или ваш клон — сверяйте в игре.</p></details>
      <div className="industry-actions"><button className="primary-button" disabled={!api || scanning || !character?.skills} onClick={() => void scan(false)}>{scanning ? 'Сканирование…' : 'Найти прибыль'}</button>
        <button className="secondary-button" disabled={!api || scanning || !character?.skills} onClick={() => void scan(true)}>Обновить цены и пересчитать</button>
        {scanning && <button className="secondary-button" onClick={() => void api?.cancelIndustryScan().catch(caught => setError(messageOf(caught)))}>Остановить индексацию</button>}</div>
      {!character?.skills && <p>Без активных навыков расчёт заблокирован — не подставляем нулевые навыки. Нужно разрешение <code>{INDUSTRY_SCOPES.skills}</code>.</p>}</div>
    {progress && <div className="industry-progress" role="status"><span>{progress.message}</span><progress max={progress.total || 1} value={progress.completed} /><small>{scanning ? 'Готовые строки появляются сразу; дождитесь завершения для итогового снимка.' : result ? 'Сканирование завершено' : 'Сканирование не завершено. Найденные расчёты предварительные — повторите поиск для продолжения.'}</small></div>}
    {result && <div className="industry-result-context"><strong>{result.productionSystemName} · manufacturing SCI {(result.systemCostIndex * 100).toFixed(3)}%</strong>
      <p>Снимок ESI на {new Date(result.marketFetchedAt).toLocaleString('ru-RU')} · возраст {Math.max(0, Math.floor((clock - Date.parse(result.marketFetchedAt)) / 60000))} мин. · SDE {result.catalogBuild}. Расчёт: длинные задания + общий план {result.request.massProduction?.lines ?? 9} линий.</p>
      <p className="industry-warning">ESI обновляет ордера примерно раз в 5 минут; обновление не обходит кеш CCP. Multibuy считает всю партию материала по единой цене, покрывающей количество; BUY — аналогично по нижней принимающей цене. Перед закупкой обновите расчёт и сверяйте Multibuy и окно запуска.</p>
      {clock - Date.parse(result.marketFetchedAt) > 600000 && <p className="industry-negative">Цены устарели — более 10 минут. Нажмите «Обновить цены и пересчитать».</p>}
      <p>Результаты относятся к параметрам последнего сканирования. После изменения параметров пересчитайте.</p>
      {settingsChanged && <p className="industry-warning" role="status">Параметры изменены. Карточки пока показывают предыдущую партию — нажмите «Найти прибыль» для нового расчёта.</p>}
      <details><summary>Допущения расчёта</summary>{result.warnings.map(w => <p key={w}>{w}</p>)}</details></div>}
    {result?.massPlan && <IndustryMassPanel plan={result.massPlan} stale={settingsChanged} />}
    <div className="industry-filters industry-fields"><label>Найти предмет<input value={query} placeholder="Например, Venture" onChange={e => setQuery(e.target.value)} /></label>
      <label>Сортировка · длинные партии BUY<select value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="profit">BUY · прибыль длинной партии</option><option value="hour">BUY · ISK / час длинного задания</option><option value="margin">BUY · доходность всей закупки</option></select></label>
      <NumberField label="Общий бюджет цикла, ISK · 0 = без лимита" value={budget} max={1e15} onChange={setBudget} />
      <NumberField label="Минимум прибыли BUY на партию, ISK" value={minimumProfit} max={1e15} onChange={setMinimumProfit} />
      <NumberField label="Продажи / день · минимум за 30 дней" value={minimumDaily} max={1e12} onChange={setMinimumDaily} /></div>
    <div className="industry-filter-checks"><label className="industry-check"><input type="checkbox" checked={onlyProfitable} onChange={e => setOnlyProfitable(e.target.checked)} />Прибыльные в BUY</label>
      <label className="industry-check"><input type="checkbox" checked={onlyReady} onChange={e => setOnlyReady(e.target.checked)} />Хватает покупателей, ресурсов и навыков</label><span>Подходит: {filtered.length} из {rows.length} · показано с фильтром спроса: {displayed.length}</span></div>
    {rows.length > 0 && <div className="industry-scan-summary"><strong>Варианты длинных заданий · материалы только с рынка</strong><span>Подходящих прибыльных партий: {salesRows.filter(r => industryMassReasons(r, { ...massSettings, budget }).length === 0).length}</span><button className="secondary-button" onClick={() => { setOnlyProfitable(true); setOnlyReady(true); setSort('profit') }}>Прибыльные длинные партии</button><button className="secondary-button" onClick={resetFilters}>Показать все расчёты</button><p>Главная прибыль — после полной оплаты BPC/BPO. В общем плане один чертёж и один объём ресурсов / BUY не используются дважды. Список ниже — отдельные варианты, не девять независимых обещаний прибыли.</p></div>}
    {result && factoryBlueprint !== null && salesRows.find(r => r.blueprintTypeId === factoryBlueprint) && <div ref={factoriesPanel} className="industry-factories"><IndustryFactories key={`${result.scanId}_${factoryBlueprint}_${settings.salesMode}_${settings.brokerFeePercent}`} api={api} result={result} row={salesRows.find(r => r.blueprintTypeId === factoryBlueprint)!} basis={basis} brokerFeePercent={settings.brokerFeePercent ?? 3} onSelect={f => {
      setSettings(current => ({ ...current, productionSystem: f.systemName, facilityTaxPercent: 0.25, materialReductionPercent: 0, timeReductionPercent: 0, jobCostReductionPercent: 0 }))
      setSelectedFactory(`${f.name} · ${f.facilityId}`)
    }} />{materialMode !== 'market' && <p className="industry-warning">Таблица фабрик сравнивает полный рецепт по рыночным ценам, без вычета ваших запасов. Смешанная себестоимость показана в карточке товара.</p>}</div>}
    {rows.length > 0 && <p>Список — длинные BUY-партии, не одиночные прогоны. Фильтры ниже меняют список вариантов; общий план выше пересчитывается только новым поиском. После изменения бюджета нажмите «Найти прибыль». Покупатели могут изменить ордера до окончания производства. История спроса — региональная, не обещание продажи.</p>}
    <div className="industry-opportunities">{displayed.map(row => <IndustryMassJobCard key={row.blueprintTypeId} row={row} settings={massSettings} liquidity={liquidity[row.productTypeId] !== undefined ? liquidity[row.productTypeId] : result?.massPlan?.liquidity.find(h => h.typeId === row.productTypeId)} brokerFeePercent={result?.request.brokerFeePercent ?? settings.brokerFeePercent ?? 3} onFactories={result ? () => setFactoryBlueprint(row.blueprintTypeId) : undefined} />)}
      {filtered.length > 0 && displayed.length === 0 && minimumDaily > 0 && <p>Среди загруженных карточек нет подтверждённых продаж выше заданного минимума. История ещё загружается либо спрос ниже; уменьшите фильтр или покажите следующие 100.</p>}
      {!scanning && rows.length > 0 && filtered.length === 0 && <div className="workspace-empty"><p>Под фильтры не подошла ни одна из {rows.length} проверенных позиций. Для прибыльного BUY нужны покупатели на всю партию, ресурсы, навыки и бюджет. Высокий SELL без BUY сюда не попадает. Нажмите «Показать все расчёты», чтобы увидеть стоимость и причины отказа.</p><button className="secondary-button" onClick={resetFilters}>Показать все расчёты</button></div>}
      {!scanning && result && rows.length === 0 && <p>В выбранном источнике не найдено доступных производственных чертежей. Проверьте регионы и допущения сканирования.</p>}
      {filtered.length > visibleCount && <button className="secondary-button" onClick={() => setVisibleCount(v => v + 100)}>Показать ещё 100</button>}</div>
  </section>
}
export function IndustryPlanningCard({ row, liquidity, decision: suppliedDecision, brokerFeePercent = 3, ...costProps }: {
  row: IndustryOpportunity; liquidity?: IndustryLiquidity | null; brokerFeePercent?: number; decision?: IndustryBuyDecision
  materialMode?: IndustryMaterialCostMode; stockLocationId?: number; purchases?: ReadonlyMap<number, PurchaseBasis>; purchaseSince?: string
  stock?: ReadonlyMap<number, number>; useStock?: boolean; onFactories?: () => void
}): React.JSX.Element {
  const view = (quote: IndustryOpportunity, mode: 'buy' | 'sell'): IndustryOpportunity => industryMaterialCostView(industrySalesView(quote, mode, brokerFeePercent), costProps.purchases ?? new Map(), costProps.materialMode ?? 'market', costProps.stockLocationId)
  const decision = suppliedDecision ?? industryBuyDecision(row, { ...costProps, brokerFeePercent })
  const chosen = decision.quote
  const batches: Array<{ label: string; quote: IndustryOpportunity }> = [{ label: '1 прогон', quote: row }]
  if (chosen.runs !== row.runs) batches.push({ label: 'Выбранная партия BUY', quote: chosen })
  if (row.plan?.full) batches.push({ label: 'Весь BPC', quote: row.plan.full })
  if (row.plan?.profitableBuy && row.plan.profitableBuy.runs > 1 && !batches.some(b => b.quote.runs === row.plan!.profitableBuy!.runs)) batches.push({ label: 'Прибыльная партия BUY · ресурсы доступны', quote: row.plan.profitableBuy })
  const fullRuns = row.plan?.fullRuns
  if (row.plan?.production && row.plan.production.runs > 1 && !batches.some(b => b.quote.runs === row.plan!.production!.runs)) batches.push({ label: fullRuns === null ? 'По ресурсам · одно задание BPO' : 'Доступно по ресурсам', quote: row.plan.production })
  if (row.plan?.immediate && row.plan.immediate.runs > 1 && !batches.some(b => b.quote.runs === row.plan!.immediate!.runs)) batches.push({ label: 'Можно произвести и продать BUY', quote: row.plan.immediate })
  const oneBuy = view(row, 'buy'), oneSell = view(row, 'sell')
  const priceAge = row.marketSnapshotAt ? Math.max(0, Math.floor((Date.now() - Date.parse(row.marketSnapshotAt)) / 60000)) : null
  return <article className="industry-opportunity industry-plan">
    <header><div><h3>{row.productName}</h3><p className="industry-blueprint-name">{row.blueprintName} · {blueprintLabel(row)} · ME {row.blueprint.me} / TE {row.blueprint.te}</p>
      <p>{row.blueprint.contractId ? `Контракт #${row.blueprint.contractId}` : row.blueprint.itemId ? 'Собственный чертёж' : 'Рынок BPO'} · {row.blueprint.systemName ?? `место #${row.blueprint.locationId ?? 'неизвестно'}`}</p></div>
      <div className="industry-demand"><strong>{liquidity ? `${liquidity.daily30.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} шт. / день` : liquidity === null ? 'История недоступна' : 'Загружаю продажи / день…'}</strong>
        {liquidity && <><small>7 дней: {liquidity.daily7.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} шт./день · 30 дней: {liquidity.volume30.toLocaleString('ru-RU')} шт.</small><small>Дни с продажами: {liquidity.activeDays30}/30 · последняя сделка: {liquidity.lastTrade ?? 'нет'}</small><small>Регион {liquidity.regionId === 10000002 ? 'The Forge' : liquidity.regionId}, НЕ отдельная станция Jita · по {liquidity.through} UTC</small></>}
      </div></header>
    {liquidity && (liquidity.daily30 < 1 || liquidity.activeDays30 < 5 || liquidity.stale) && <p className="industry-negative">{liquidity.stale ? 'История устарела; спрос не подтверждён.' : 'Низкая ликвидность: редкие продажи. Прибыль SELL не означает, что товар быстро купят.'}</p>}
    {priceAge !== null && <p className={priceAge > 10 ? 'industry-negative' : 'industry-warning'}>Снимок цен: {new Date(row.marketSnapshotAt!).toLocaleString('ru-RU')} · {priceAge} мин. назад{priceAge > 10 ? ' · устарел, обновите перед закупкой' : ' · ESI кешируется около 5 минут'}</p>}
    {priceAge === null && <p className="industry-warning">Возраст цен неизвестен — обновите перед закупкой.</p>}
    <div className={`industry-buy-decision ${decision.profitable ? 'is-profitable' : 'is-blocked'}`}>
      <strong>{decision.profitable ? 'BUY покрывает партию · прибыль по снимку' : decision.executable ? 'BUY есть, но производство в убыток' : 'Не готово для продажи в BUY'}</strong>
      <span>{chosen.runs.toLocaleString('ru-RU')} прогонов → {chosen.outputQuantity.toLocaleString('ru-RU')} шт. · {chosen.hours.toFixed(2)} ч. производства</span>
      <div className="industry-buy-metrics"><div><small>BUY · ISK / час одного слота</small><strong>{isk(decision.hourly)}</strong></div>
        <div><small>Прибыль всей партии · после налога</small><strong>{isk(decision.executable ? chosen.repeatProfit : null)}</strong><small>На 1 прогон: {isk(decision.executable && chosen.repeatProfit !== null ? chosen.repeatProfit / chosen.runs : null)}</small></div>
        <div><small>Нужно ISK до продажи · весь чертёж учтён</small><strong>{isk(chosen.capitalRequired)}</strong></div></div>
      <span>BUY принимает {chosen.outputFill.filledQuantity.toLocaleString('ru-RU')} из {chosen.outputQuantity.toLocaleString('ru-RU')} шт. · цена приёма {isk(chosen.outputFill.complete ? chosen.outputFill.averagePrice : null)} / шт.</span>
      {decision.executable && <small>Выручка {isk(chosen.grossRevenue)} − все расходы с налогом {isk(chosen.grossRevenue! - chosen.repeatProfit!)} = прибыль {isk(chosen.repeatProfit)}. Стоимость 1 прогона с налогом: {isk((chosen.grossRevenue! - chosen.repeatProfit!) / chosen.runs)}.</small>}
      {row.blueprint.source.endsWith('copy') && <small>Расход BPC на 1 прогон: {isk(chosen.blueprint.cost === null ? null : chosen.blueprint.cost / chosen.runs)}. В закупку входит полная цена контракта, в прибыль — только израсходованные прогоны.</small>}
      {decision.reasons.length > 0 && <p className="industry-negative">{decision.reasons.join(' · ')}</p>}
      {!row.blueprint.source.endsWith('copy') && <small>BPO не расходуется: прибыль выше без списания покупки BPO. Первая партия с покупкой BPO: {isk(chosen.profit)}.</small>}
      <small>Это BUY сейчас, не гарантия продажи после крафта. ISK/час не учитывает ожидание слота, перевозку и ручные действия.</small>
      {liquidity && !liquidity.stale && <small>Партия / средние продажи региона за день: {liquidity.daily30 > 0 ? `${(chosen.outputQuantity / liquidity.daily30 * 100).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}%` : 'продаж за 30 дней нет'}. Это масштаб партии, не срок продажи.</small>}
    </div>
    <IndustryPlanDetails label="Выбранная партия BUY" row={chosen} costProps={costProps} />
    <details className="industry-plan-comparison"><summary>Сравнить 1 прогон, весь BPC и SELL · SELL не влияет на рейтинг</summary>
    <div className="industry-plan-investment"><span>Купить {row.blueprint.contractId ? 'контракт целиком' : 'чертёж'}: <strong>{isk(row.blueprint.purchaseCost)}</strong></span>
      <span>{row.blueprint.source.endsWith('copy') ? `BPC на прогон: ${isk(row.blueprint.cost)} · остаток ${fullRuns ?? row.blueprint.availableRuns ?? 'неизвестно'} прогонов` : `BPO сохраняется · окупаемость BUY: ${oneBuy.breakEvenBatches === null ? 'не подтверждена' : `${oneBuy.breakEvenBatches} прогонов`}`}</span>
      <small>Сравнено предложений чертежа: {row.plan?.sourceCount ?? 1}. Выбран лучший расчёт 1 прогона, не гарантия лучшей полной партии.</small></div>
    <div className="industry-plan-table"><table><thead><tr><th>Объём производства</th><th>Себестоимость производства</th><th>BUY · продать сразу</th><th>SELL · ордер, ждать</th><th>Время</th></tr></thead><tbody>{batches.map(({ label, quote }, i) => {
      const buy = view(quote, 'buy'), sell = view(quote, 'sell')
      const productionCost = buy.materialCost === null || buy.installationCost === null || buy.blueprint.cost === null ? null : buy.materialCost + buy.installationCost + buy.transportCost + (buy.blueprint.source.endsWith('copy') ? buy.blueprint.cost : 0)
      return <tr key={`${label}_${i}`}><td><strong>{label}</strong><small>{quote.runs.toLocaleString('ru-RU')} прогонов → {quote.outputQuantity.toLocaleString('ru-RU')} шт.</small>{buy.materialCost === null && <small className="industry-negative">Не хватает материалов / цены на партию</small>}</td>
        <td>{isk(productionCost)}<small>Материалы + запуск + доставка + расход BPC</small><small>Нужно ISK до продажи: {isk(buy.capitalRequired)} · покупка всего чертежа учтена</small></td>
        <td className={buy.repeatProfit !== null && buy.repeatProfit > 0 ? 'industry-profit-cell' : 'industry-loss-cell'}><strong>{isk(buy.repeatProfit)}</strong><small>Чистая прибыль, налог {buy.salesTaxPercent.toFixed(3)}%</small><small>Выручка: {isk(buy.grossRevenue)} · расходы с налогом: {isk(buy.grossRevenue === null || buy.repeatProfit === null ? null : buy.grossRevenue - buy.repeatProfit)}</small>{!buy.outputFill.complete && <small>BUY принимает {buy.outputFill.filledQuantity.toLocaleString('ru-RU')} из {quote.outputQuantity.toLocaleString('ru-RU')} шт.</small>}</td>
        <td className={sell.repeatProfit !== null && sell.repeatProfit > 0 ? 'industry-profit-cell industry-sell-estimate' : 'industry-loss-cell'}><strong>{isk(sell.repeatProfit)}</strong><small>Оценка после налога + брокера {brokerFeePercent}%</small><small>Выручка: {isk(sell.grossRevenue)} · расходы с комиссиями: {isk(sell.grossRevenue === null || sell.repeatProfit === null ? null : sell.grossRevenue - sell.repeatProfit)}</small><small>Покупатель и срок не гарантированы</small></td><td>{quote.hours.toFixed(2)} ч.</td></tr>
    })}</tbody></table></div>
    {row.plan && <p className="industry-capacity">По рыночным ресурсам: {row.plan.production?.runs ?? 0} прогонов. Ресурсы + BUY: {row.plan.immediate?.runs ?? 0} прогонов. {fullRuns === null ? 'BPO не расходуется; лимит — одно задание, до 30 дней и 100000 прогонов.' : `${row.plan.production?.runs === fullRuns ? 'Ресурсов хватает на весь BPC.' : 'Весь BPC сейчас не обеспечен ресурсами / лимитом времени.'}`} Максимальный BUY-объём может быть убыточным: прибыльная BUY-партия проверена отдельно по границам цен. {costProps.materialMode === 'mixed' ? ' Эти лимиты и подбор BUY проверены по рынку; свои запасы дополнительно учитываются в строках себестоимости.' : ''}</p>}
    {!row.blueprint.source.endsWith('copy') && <p>С покупкой BPO первая партия 1 прогона: BUY {isk(oneBuy.profit)} · SELL {isk(oneSell.profit)}. В таблице BPO не списан в расходы: это отдельное многоразовое вложение.</p>}
    <div className="industry-required-skills"><strong>Навыки · ваш / требуется</strong>{row.requiredSkills.map(s => <span key={s.typeId} className={s.active >= s.required ? 'industry-positive' : 'industry-negative'}>{s.name} {s.active}/{s.required}</span>)}</div>
    {row.blueprint.source === 'owned-copy' && <p className="industry-warning">Цена собственного BPC неизвестна: добавьте её расход к расчёту. Показанная прибыль без стоимости копии — верхняя оценка.</p>}
    <p className="industry-warning">SELL — цена конкурентов, не подтверждённые покупатели. История — все сделки региона, не отдельные BUY/SELL и не прогноз срока продажи. {row.missingSkills.length > 0 ? 'Навыков для запуска не хватает.' : ''}</p>
    {costProps.onFactories && <button className="secondary-button" onClick={costProps.onFactories}>Сравнить фабрики · до 10 прыжков · 1 прогон</button>}
    {batches.map(({ label, quote }, i) => <IndustryPlanDetails key={`${label}_details_${i}`} label={label} row={view(quote, 'buy')} costProps={costProps} />)}
    </details>
  </article>
}
function IndustryPlanDetails({ label, row, costProps }: { label: string; row: IndustryOpportunity; costProps: Omit<Parameters<typeof IndustryPlanningCard>[0], 'row' | 'liquidity' | 'brokerFeePercent' | 'decision'> }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return <details className="industry-plan-details" onToggle={event => setOpen(event.currentTarget.open)}><summary>{label} · подробные цены, материалы и Multibuy</summary>{open && <IndustryOpportunityCard {...costProps} row={row} selectedProfit={row.repeatProfit} basis="repeat" onFactories={undefined} />}</details>
}
export function IndustryOpportunityCard({ row, selectedProfit = row.profit, basis = 'first', stock, useStock = false, onFactories, onUseQuantity, purchases, purchaseSince, materialMode = 'market', stockLocationId }: { row: IndustryOpportunity; selectedProfit?: number | null; basis?: 'first' | 'repeat'; stock?: ReadonlyMap<number, number>; useStock?: boolean; onFactories?: () => void; onUseQuantity?: (quantity: number) => void; purchases?: ReadonlyMap<number, PurchaseBasis>; purchaseSince?: string; materialMode?: IndustryMaterialCostMode; stockLocationId?: number }): React.JSX.Element {
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const purchaseQuote = materialMode !== 'market' ? industryPurchaseQuote(row, purchases ?? new Map(), basis, materialMode, stockLocationId) : null
  const shoppingList = row.materials.map(m => ({ ...m, buyQuantity: materialMode === 'mixed' ? purchaseQuote!.materials.find(p => p.typeId === m.typeId)!.marketQuantity : useStock ? Math.max(0, m.quantity - (stock?.get(m.typeId) ?? 0)) : m.quantity }))
  const copyShoppingList = async (): Promise<void> => {
    try {
      const text = shoppingList.filter(m => m.buyQuantity > 0).map(m => `${m.name}\t${m.buyQuantity}`).join('\n')
      if (!text) { setCopyStatus('Все материалы уже есть в выбранном Hangar'); return }
      await navigator.clipboard.writeText(text); setCopyStatus('Список скопирован — вставьте в EVE Multibuy')
    } catch { setCopyStatus('Не удалось записать буфер обмена. Скопируйте список материалов вручную') }
  }
  return <article className="industry-opportunity"><header><div><h3>{row.productName}</h3><p className="industry-blueprint-name">{row.blueprintName} · {blueprintLabel(row)}{row.blueprint.contractId ? ` · контракт #${row.blueprint.contractId}` : ''}</p><span>{row.runs} запусков → {row.outputQuantity.toLocaleString('ru-RU')} шт. · {row.hours.toFixed(2)} ч · ME {row.blueprint.me} / TE {row.blueprint.te}</span></div>
    <strong className={selectedProfit !== null && selectedProfit > 0 ? 'industry-positive' : 'industry-negative'}>{isk(selectedProfit)}<small>{basis === 'first' ? 'Прибыль партии · покупка BPO учтена' : 'Прибыль партии · BPC учтён / BPO уже есть'}</small></strong></header>
    <div className="industry-totals"><div className="industry-revenue"><small>{row.salesMode === 'buy' ? 'Выручка · BUY · сразу' : 'Выручка · SELL · оценка'}</small><strong>{isk(row.grossRevenue)}</strong></div><div className="industry-cost"><small>Все расходы · партия, с комиссией</small><strong>{isk(selectedProfit === null || row.grossRevenue === null ? null : row.grossRevenue - selectedProfit)}</strong></div><div className={selectedProfit !== null && selectedProfit > 0 ? 'industry-profit' : 'industry-loss'}><small>Чистая прибыль на 1 прогон</small><strong>{isk(selectedProfit === null ? null : selectedProfit / row.runs)}</strong><small>На 1 предмет: {isk(selectedProfit === null ? null : selectedProfit / row.outputQuantity)}</small></div></div>
    {materialMode === 'mixed' ? <div className="industry-capacity"><strong>Проверка смешанной партии · {row.runs} прогонов → {row.outputQuantity.toLocaleString('ru-RU')} шт.</strong><span className={row.materialCost !== null ? 'industry-positive' : 'industry-negative'}>{row.materialCost !== null ? 'Свои запасы + рыночная закупка покрывают всю партию; стоимость известна' : 'На запрошенную партию не хватает цены или объёма закупки — причины ниже'}</span><span>BUY принимает {row.outputFill.filledQuantity.toLocaleString('ru-RU')} из {row.outputQuantity.toLocaleString('ru-RU')} шт.</span><small>Проверяется именно эта партия. Для меньшего количества пересчитайте: округление ME и минимальные лоты меняют закупку.</small></div> : <div className="industry-capacity"><strong>Проверка объёма · цель {row.requestedQuantity.toLocaleString('ru-RU')} шт. → фактически {row.outputQuantity.toLocaleString('ru-RU')} шт.</strong><span>Материалов хватает: {row.maxMaterialRuns} из {row.runs} прогонов</span><span>BUY принимает: {row.outputFill.filledQuantity.toLocaleString('ru-RU')} из {row.outputQuantity.toLocaleString('ru-RU')} шт. · {row.maxBuyRuns} полных прогонов</span><span className={row.maxFeasibleRuns >= row.runs ? 'industry-positive' : 'industry-negative'}>Проверенный лимит партии: {row.maxFeasibleRuns} прогонов → {(row.maxFeasibleRuns * row.outputQuantity / row.runs).toLocaleString('ru-RU')} шт.{row.salesMode === 'sell' ? ' · без гарантии продажи' : ''}</span><small>Лимит не выше запрошенной партии; учитывает материалы, BPC, длительность, а для BUY — покупателей. Минимальные лоты могут запрещать меньшие партии. Навыки проверяются отдельно.</small>
      {row.maxFeasibleRuns > 0 && row.maxFeasibleRuns < row.runs && onUseQuantity && <button className="secondary-button" onClick={() => onUseQuantity(row.maxFeasibleRuns * row.outputQuantity / row.runs)}>Подставить доступное количество · затем пересчитать</button>}</div>}
    <div className="industry-economics"><span>{row.blueprint.source === 'contract-copy' ? 'BPC · цена одного прогона' : 'Покупка BPO / своего BPC'}<strong>{isk(row.blueprint.cost === null ? null : row.blueprint.source === 'contract-copy' ? row.blueprint.cost / row.runs : row.blueprint.cost)}</strong></span>
      <span>{row.blueprint.contractId ? 'Купить контракт целиком' : 'Купить чертёж'}<strong>{isk(row.blueprint.purchaseCost)}</strong></span><span>{materialMode === 'market' ? 'Материалы · sell' : materialMode === 'mixed' ? 'Материалы · свои + рынок' : 'Материалы · история покупок'}<strong>{isk(row.materialCost)}</strong></span>
      <span>Запуск · вся партия<strong>{isk(row.installationCost)}</strong></span><span>{row.salesMode === 'buy' ? 'Выручка · buy' : 'Выручка · sell · оценка'}<strong>{isk(row.grossRevenue)}</strong></span><span>Налог {row.salesTaxPercent.toFixed(3)}%<strong>{isk(row.salesTax)}</strong></span><span>Брокерская комиссия<strong>{isk(row.brokerFee)}</strong></span><span>Доставка · партия<strong>{isk(row.transportCost)}</strong></span>
      <span>Стоимость 1 прогона · с комиссиями<strong>{isk(selectedProfit === null || row.grossRevenue === null ? null : (row.grossRevenue - selectedProfit) / row.runs)}</strong></span>
      <span>{row.blueprint.contractId ? 'Нужно ISK · весь контракт + партия' : basis === 'first' ? 'Нужно ISK с BPO' : 'Нужно ISK без покупки BPO'}<strong>{isk(capitalForBasis(row, basis))}</strong></span><span>Прибыль на прогон · BPO уже есть<strong>{isk(row.repeatProfit === null ? null : row.repeatProfit / row.runs)}</strong></span><span>ISK / час<strong>{isk(selectedProfit !== null && row.hours > 0 ? selectedProfit / row.hours : null)}</strong></span>
      <span>Окупаемость BPO<strong>{row.blueprint.source.endsWith('copy') ? 'BPC расходуется' : row.breakEvenBatches === null ? 'не окупается / неизвестна' : `${row.breakEvenBatches} партий`}</strong></span></div>
    {purchaseQuote && <div className="industry-purchase-cost"><h4>{materialMode === 'mixed' ? 'Свои запасы + рынок' : 'По вашим покупкам'} · с {purchaseSince} · оценка</h4>
      <div className="industry-totals"><div className="industry-cost"><small>{materialMode === 'mixed' ? 'Материалы · свои + рыночная докупка' : 'Материалы · средняя цена ваших покупок'}</small><strong>{isk(purchaseQuote.materialCost)}</strong></div><div className="industry-cost"><small>Все расходы на 1 прогон · с комиссиями</small><strong>{isk(purchaseQuote.totalCost === null ? null : purchaseQuote.totalCost / row.runs)}</strong></div><div className={purchaseQuote.profit !== null && purchaseQuote.profit > 0 ? 'industry-profit' : 'industry-loss'}><small>{materialMode === 'mixed' ? 'Прибыль партии · свои + рынок' : 'Прибыль партии по ценам покупок'}</small><strong>{isk(purchaseQuote.profit)}</strong><small>На 1 прогон: {isk(purchaseQuote.profit === null ? null : purchaseQuote.profit / row.runs)}</small></div></div>
      {materialMode === 'mixed' && <p>Докупить материалов за: <strong>{isk(purchaseQuote.marketCost)}</strong>. Свои материалы тоже входят в себестоимость; повторно покупать их не нужно.</p>}
      <p>Средневзвешенная цена за выбранный период, не точное списание со склада. Остальные расходы и будущая выручка — расчётные. Фильтры прибыли, бюджета и сортировка используют выбранный способ оценки.</p>
      <details><summary>Разбор стоимости материалов</summary><div className="industry-material-list">{purchaseQuote.materials.map(m => <div key={m.typeId}><span>{m.name}<small> · куплено {m.purchasedQuantity.toLocaleString('ru-RU')} шт. за период</small></span><span>На партию {m.quantity.toLocaleString('ru-RU')} шт.<small>{materialMode === 'mixed' ? ` · своих ${m.ownQuantity} · докупить ${m.marketQuantity} · ${m.valuedQuantity} своих оценены по рынку` : ''} · ваша средняя {m.unitPrice === null ? 'нет цены покупки' : isk(m.unitPrice)} / шт.</small></span><span>{m.cost === null ? m.reasons.join(' · ') : isk(m.cost)}</span></div>)}</div></details>
      {purchaseQuote.materialCost === null && <p className="industry-warning">Себестоимость и прибыль неизвестны: {materialMode === 'mixed' ? 'не хватает реальной цены или sell-объёма на докупку; проверьте разбор материалов' : 'история не покрывает партию; переключите на «Только рынок» или «Свои запасы + докупить с рынка»'}.</p>}
    </div>}
    <p className={row.marketReady ? 'industry-positive' : 'industry-warning'}>{row.marketReady ? row.salesMode === 'buy' ? 'Навыки и объёмы рынка подходят' : 'Навыки и материалы подходят · SELL требует покупателя' : 'Есть ограничения — проверьте причины ниже'}</p>
    {onFactories && <button className="secondary-button" onClick={onFactories}>Сравнить фабрики · до 10 прыжков</button>}
    <div className="industry-required-skills"><strong>Навыки · ваш / требуется</strong>{row.requiredSkills.map(s => <span key={s.typeId} className={s.active >= s.required ? 'industry-positive' : 'industry-negative'}>{s.name} {s.active}/{s.required} {s.active >= s.required ? '✓' : '— нужно обучить'}</span>)}</div>
    {row.warnings.map(w => <p className="industry-warning" key={w}>{w}</p>)}
    <details><summary>Полный расчёт · материалы, закупка и место чертежа</summary><p>{blueprintLabel(row)} · {row.blueprint.systemName ?? 'место по ID'} · {row.blueprint.locationId ?? 'нет предложения'}</p>
      {row.blueprint.source === 'contract-copy' && <p>Стоимость BPC на один прогон: {isk(row.blueprint.purchaseCost)} / {row.blueprint.availableRuns} = {isk(row.blueprint.cost === null ? null : row.blueprint.cost / row.runs)}. Для покупки нужны ISK на весь контракт; неиспользованные запуски остаются в копии.</p>}
      <p>Прибыль на прогон = (выручка {row.salesMode.toUpperCase()} − налог продажи − комиссия − материалы {materialMode === 'market' ? 'SELL' : materialMode === 'mixed' ? 'свои + рынок' : 'по истории покупок'} − запуск − доставка − распределённая цена BPC) / {row.runs}: {isk(row.repeatProfit === null ? null : row.repeatProfit / row.runs)}. BPO — многоразовый актив; в повторной партии его покупка не списывается.</p>
      <p>Первая партия с полной покупкой BPO (для BPC — распределённая цена): {isk(row.profit)}.</p>
      <p>Цена продажи за штуку: {isk(row.salesMode === 'buy' ? row.outputFill.averagePrice : row.sellUnitPrice)}{row.salesMode === 'buy' && !row.outputFill.complete ? ' (только доступный объём, не вся партия)' : ''}. Выручка после всех комиссий: {isk(row.grossRevenue === null || row.salesTax === null || row.brokerFee === null ? null : row.grossRevenue - row.salesTax - row.brokerFee)}.</p>
      <p>{materialMode === 'mixed' ? 'Список Multibuy содержит только докупку. Ниже sell-цены показаны для сравнения полного рыночного рецепта; себестоимость своих запасов не обнуляется.' : 'Рыночная закупка всех материалов по sell-ордерам показана ниже для сравнения. В выбранном режиме прибыль включает стоимость материалов, даже если они уже есть.'}</p>
      <p>Цена материала — единый лимит Multibuy на всё его количество, не средняя цена отдельных сделок. Покупая по одному ценовому уровню вручную, можно дешевле; результат сверяйте в EVE.</p>
      <div className="industry-material-list">{shoppingList.map(m => <div key={m.typeId}><span>{m.name}<small> · sell {isk(m.fill.averagePrice)} / шт.</small></span><span>{m.quantity.toLocaleString('ru-RU')} шт.<small> · в Hangar {stock ? stock.get(m.typeId) ?? 0 : 'неизвестно'} · купить {m.buyQuantity}</small></span><span>{m.fill.complete ? isk(m.fill.total) : `Не хватает ${m.fill.missingQuantity.toLocaleString('ru-RU')} шт. · доступный объём ${isk(m.fill.total)}`}</span></div>)}</div>
      <button className="secondary-button" onClick={() => void copyShoppingList()}>Скопировать список для Multibuy</button>
      {copyStatus && <p role="status">{copyStatus}</p>}
      <p>Покупатели принимают {row.outputFill.filledQuantity.toLocaleString('ru-RU')}/{row.outputQuantity.toLocaleString('ru-RU')} шт. Сейчас; цена может измениться к завершению производства. Брокерская комиссия мгновенных сделок: 0. SELL-ордера конкурентов не считаются покупателями.</p></details></article>
}

function IndustryFactories({ api, result, row, basis, brokerFeePercent, onSelect }: { api: IndustryApi | null; result: IndustryScanResult; row: IndustryOpportunity; basis: 'first' | 'repeat'; brokerFeePercent: number; onSelect: (quote: IndustryFactoryQuote) => void }): React.JSX.Element {
  const [origin, setOrigin] = useState(MARKET_HUBS.find(h => h.id === result.request.buyHubId)!.name as string)
  const [highSec, setHighSec] = useState(true)
  const [data, setData] = useState<IndustryFactoryResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => () => { generation.current++ }, [])
  const search = async (): Promise<void> => {
    if (!api) return
    const id = ++generation.current
    setBusy(true); setError(null); setData(null)
    try {
      const found = await api.getIndustryFactories({ scanId: result.scanId, blueprintTypeId: row.blueprintTypeId, originSystem: origin, maxJumps: 10, highSecOnly: highSec, salesMode: row.salesMode, brokerFeePercent })
      if (id === generation.current) setData(found)
    } catch (caught) { if (id === generation.current) setError(messageOf(caught)) }
    finally { if (id === generation.current) setBusy(false) }
  }
  return <section className="industry-factories finance-panel" aria-label="Сравнение фабрик"><h2>Фабрики · {row.productName} · {row.outputQuantity} шт.</h2><div className="industry-fields"><label>От какой системы · до 10 прыжков<input value={origin} onChange={e => { setOrigin(e.target.value); generation.current++; setBusy(false); setData(null) }} /></label><label className="industry-check"><input type="checkbox" checked={highSec} onChange={e => { setHighSec(e.target.checked); generation.current++; setBusy(false); setData(null) }} />Только маршруты через high-sec</label><button className="secondary-button" disabled={!api || busy} onClick={() => void search()}>{busy ? 'Ищу фабрики…' : 'Найти фабрики до 10 прыжков'}</button></div>
    <p>Стоимость запуска и время всей партии. NPC-модель: 0.25% EIV, без ригов и бонусов сооружений. Навыки и ME/TE вашего чертежа сохранены. Перевозка — сумма последнего расчёта, не тариф за прыжок.</p>
    {error && <p role="alert" className="industry-negative">{error}</p>}
    {chosen && <p role="status" className="industry-positive">Выбрано: {chosen}. Система и параметры NPC подставлены; нажмите «Найти прибыль» выше для пересчёта всех чертежей.</p>}
    {data && <><p>{data.originSystemName} · найдено {data.rows.length} фабрик · {highSec ? 'high-sec маршрут' : 'кратчайший маршрут, включая опасные системы'} · {new Date(data.fetchedAt).toLocaleTimeString('ru-RU')}</p>{data.rows.length === 0 ? <p>В этом радиусе публичных NPC-фабрик не найдено.</p> : <div className="industry-factory-table"><table><thead><tr><th>Фабрика / система</th><th>Прыжки</th><th>SCI</th><th>Материалы</th><th>Запуск</th><th>Время</th><th>Прибыль партии</th><th>Выбор</th></tr></thead><tbody>{data.rows.map(f => <tr key={f.facilityId}><td>{f.name}<small>{f.facilityId} · SEC {f.security.toFixed(1)}</small></td><td>{f.jumps}</td><td>{(f.systemCostIndex * 100).toFixed(3)}%</td><td>{isk(f.materialCost)}</td><td>{isk(f.installationCost)}</td><td>{f.hours.toFixed(2)} ч</td><td className={(basis === 'first' ? f.profit : f.repeatProfit) !== null && (basis === 'first' ? f.profit : f.repeatProfit)! > 0 ? 'industry-positive' : 'industry-negative'}>{isk(basis === 'first' ? f.profit : f.repeatProfit)}</td><td><button className="secondary-button" onClick={() => { onSelect(f); setChosen(f.name) }}>Выбрать</button></td></tr>)}</tbody></table></div>}{data.warnings.map(w => <p className="industry-warning" key={w}>{w}</p>)}</>}
  </section>
}
export function IndustryJobCard({ job, now }: { job: IndustryJob; now: number }): React.JSX.Element {
  const ready = jobReadyToDeliver(job, now)
  const minutes = Math.ceil(Math.max(0, Date.parse(job.endDate) - now) / 60000)
  return <article className="industry-job"><strong>{job.productName ?? `Type #${job.productTypeId ?? job.blueprintTypeId}`}</strong><span>{job.runs} запусков · станция/структура {job.stationId}</span>
    <span className={ready ? 'industry-positive' : ''}>{job.status === 'paused' ? 'Приостановлено' : ready ? 'Готово по ESI / таймеру — заберите в EVE' : `Осталось ${Math.floor(minutes / 60)} ч ${minutes % 60} мин`}</span>
    <small>Завершение: {new Date(job.endDate).toLocaleString('ru-RU')} · оплаченный запуск {isk(job.cost)}</small></article>
}
function HubField({ label, value, onChange }: { label: string; value: MarketHubId; onChange: (value: MarketHubId) => void }): React.JSX.Element {
  return <label>{label}<select value={value} onChange={e => onChange(e.target.value as MarketHubId)}>{MARKET_HUBS.map(h => <option value={h.id} key={h.id}>{h.name}</option>)}</select></label>
}
function NumberField({ label, value, min = 0, max, onChange }: { label: string; value: number; min?: number; max: number; onChange: (value: number) => void }): React.JSX.Element {
  return <label>{label}<input type="number" min={min} max={max} step="any" value={Number.isFinite(value) ? value : ''} onChange={e => onChange(e.target.valueAsNumber)} /></label>
}
function isk(value: number | null): string { return value === null ? 'неизвестно' : `${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ISK` }
function capitalForBasis(row: IndustryOpportunity, basis: 'first' | 'repeat'): number | null {
  if (basis === 'repeat' && row.blueprint.source !== 'contract-copy' && row.capitalRequired !== null && row.blueprint.purchaseCost !== null) return row.capitalRequired - row.blueprint.purchaseCost
  return basis === 'first' || row.blueprint.source === 'contract-copy' ? row.capitalRequired : row.materialCost === null || row.installationCost === null || row.salesMode === 'sell' && row.brokerFee === null ? null : row.materialCost + row.installationCost + row.transportCost + (row.brokerFee ?? 0)
}
function blueprintLabel(row: IndustryOpportunity): string {
  return row.blueprint.source === 'market' ? 'Рынок · новый BPO' : row.blueprint.source.endsWith('copy') ? `BPC · осталось ${row.blueprint.availableRuns} запусков` : 'BPO · оригинал'
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
