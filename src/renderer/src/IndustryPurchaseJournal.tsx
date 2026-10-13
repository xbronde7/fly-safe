import { useMemo, useState } from 'react'
import type { IndustryLedgerSnapshot } from '../../shared/industry-ledger'

const isk = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ISK`
export function IndustryPurchaseJournal({ ledger, loading, error, since, onSince, onRefresh }: {
  ledger: IndustryLedgerSnapshot | null; loading: boolean; error: string | null; since: string
  onSince: (date: string) => void; onRefresh: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [side, setSide] = useState('buy')
  const [limit, setLimit] = useState(100)
  const rows = useMemo(() => (ledger?.transactions ?? []).filter(row => Date.parse(row.date) >= Date.parse(since) &&
    (side === 'all' || row.buy === (side === 'buy')) && row.typeName.toLowerCase().includes(query.toLowerCase())), [ledger, since, side, query])
  const bought = rows.filter(row => row.buy).reduce((sum, row) => sum + row.quantity * row.unitPrice, 0)
  const sold = rows.filter(row => !row.buy).reduce((sum, row) => sum + row.quantity * row.unitPrice, 0)
  return <details className="finance-panel industry-ledger"><summary>Журнал покупок и продаж · {ledger?.transactions.length ?? 0} сохранённых сделок</summary>
    <p>Личный кошелёк текущего чара. История сохраняется локально без дублей, не удаляется кнопкой «Clear cache». Обновляется при открытом производстве; новые сделки могут появляться с задержкой кеша ESI. Старые сделки, которые ESI уже не отдаёт, восстановить нельзя.</p>
    <div className="industry-fields"><label>Покупки для себестоимости начиная с · UTC<input type="date" value={since} onChange={e => { onSince(e.target.value); setLimit(100) }} /></label>
      <label>Материал / товар<input placeholder="Например, Tritanium" value={query} onChange={e => { setQuery(e.target.value); setLimit(100) }} /></label>
      <label>Сделки<select value={side} onChange={e => { setSide(e.target.value); setLimit(100) }}><option value="buy">Покупки</option><option value="sell">Продажи</option><option value="all">Все</option></select></label>
      <button className="secondary-button" disabled={loading} onClick={onRefresh}>{loading ? 'Загружаю кошелёк…' : 'Обновить журнал покупок'}</button></div>
    <p>По фильтру: {rows.length} сделок · куплено на {isk(bought)} · продажи {isk(sold)} до налогов. Это оборот, не прибыль производства.</p>
    {ledger?.syncedAt && <p>Успешная загрузка: {new Date(ledger.syncedAt).toLocaleString('ru-RU')}. Данные могут быть из кеша ESI.</p>}
    {error && <p role="alert" className="industry-warning">{error}</p>}
    {ledger?.warnings.map(w => <p className="industry-warning" key={w}>{w}</p>)}
    <p>Средневзвешенные цены покупок используются для своих запасов в смешанном режиме; недостающее берётся с рынка. Фильтры названия и типа сделки меняют только журнал. История покупок — не остатки Hangar: расход в других заданиях, продажи и перемещения к партии автоматически не привязываются. Чертёж, запуск, доставка и будущая продажа остаются расчётными.</p>
    <details className="industry-ledger-list"><summary>Показать список сделок · {rows.length}</summary>
    {rows.length === 0 ? <p>{loading ? 'Загружаю сделки…' : 'Нет сохранённых сделок по этому фильтру.'}</p> : <div className="industry-ledger-scroll"><table><thead><tr><th>Дата</th><th>Материал / товар</th><th>Сделка</th><th>Количество</th><th>Цена / шт.</th><th>Всего</th><th>Место · ID</th></tr></thead><tbody>
      {rows.slice(0, limit).map(row => <tr key={row.transactionId}><td>{new Date(row.date).toLocaleString('ru-RU')}</td><td>{row.typeName}</td><td>{row.buy ? 'Покупка' : 'Продажа'}</td><td>{row.quantity.toLocaleString('ru-RU')}</td><td>{isk(row.unitPrice)}</td><td className={row.buy ? 'industry-negative' : 'industry-positive'}>{isk(row.quantity * row.unitPrice)}</td><td>{row.locationId}</td></tr>)}
    </tbody></table></div>}
    {rows.length > limit && <button className="secondary-button" onClick={() => setLimit(n => n + 100)}>Показать ещё 100 сделок</button>}
    </details>
  </details>
}
