import { useEffect, useRef, useState } from 'react'
import type { MarketDepthLevel, MarketHubQuote } from '../../shared/market'
import './market-depth.css'

const number = (n: number): string => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
export function MarketOrderDepthDialog({ quote, onClose }: { quote: MarketHubQuote; onClose(): void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => { if (node?.open) node.close() } }, [])
  return <dialog className="market-book-dialog" ref={dialog} onCancel={onClose} onClose={onClose} onClick={e => { if (e.target === e.currentTarget) onClose() }} aria-label={`Глубина BUY / SELL · ${quote.hub.name}`}>
    <header><div><h2>Глубина BUY / SELL · {quote.hub.name}</h2><p>{quote.hub.stationName}</p></div><button type="button" className="secondary-button" onClick={onClose} autoFocus>Закрыть</button></header>
    <p>Снимок ESI: {new Date(quote.snapshotAt ?? quote.fetchedAt).toLocaleString('ru-RU')}{quote.cached ? ' · из кэша' : ''}. Уровни всего стакана, не только на {number(quote.quantity)} шт.</p>
    <div className="market-book-columns"><MarketDepthSide title="SELL · сейчас продают" levels={quote.depth?.sell ?? []} /><MarketDepthSide title="BUY · сейчас покупают" levels={quote.depth?.buy ?? []} /></div>
    <p className="market-book-note">Ордера только этой станции. BUY других станций с радиусом действия сюда не включены. Уровни объединены по цене; минимальные лоты могут ограничить исполнение. Кэш ESI — не торговля в реальном времени.</p>
    {!quote.depth && <p role="alert">Полный стакан не загружен. Обновите цены.</p>}
  </dialog>
}
export function MarketDepthSide({ title, levels }: { title: string; levels: MarketDepthLevel[] }): React.JSX.Element {
  const [limit, setLimit] = useState(25)
  let total = 0
  const rows = levels.slice(0, limit).map(level => ({ ...level, cumulative: total += level.quantity }))
  return <section className="market-book-side"><h3>{title}</h3><p>{levels.length.toLocaleString('ru-RU')} уровней · {number(levels.reduce((n, l) => n + l.quantity, 0))} шт.</p>
    <div className="market-book-scroll"><table><thead><tr><th>Цена, ISK</th><th>Объём</th><th>Накоплено</th><th>Ордеров</th></tr></thead><tbody>{rows.map(l => <tr key={l.price}><td>{number(l.price)}</td><td>{number(l.quantity)}</td><td>{number(l.cumulative)}</td><td>{l.orderCount}</td></tr>)}</tbody></table>{levels.length === 0 && <p>Ордеров нет</p>}</div>
    {limit < levels.length && <button type="button" className="secondary-button" onClick={() => setLimit(n => n + 50)}>Показать ещё 50 · осталось {levels.length - limit}</button>}
  </section>
}
