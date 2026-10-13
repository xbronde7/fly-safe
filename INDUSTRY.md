# Manufacturing radar (local version 1.1.13)

## Nine-line mass-production plan (1.1.13)

Manual profit search now targets long multi-run jobs: default nine lines, a
24-hour horizon, at least four hours and two runs per job. It ranks total BUY cash
profit, not a lucrative isolated run or speculative SELL hourly income. The
background BPC monitor is separate and explicitly remains one-run only;
copying factory settings into it strips mass options and quantity settings.

Each simultaneous job needs a distinct available blueprint instance. Market
BPO orders are bounded by their actual remaining quantity; each contract or
owned BPO is used at most once. Own BPCs with unknown paid price and all bundled
contracts are excluded. Own BPO availability must be confirmed by readable jobs.
New materials are always bought from the market, never assumed free stock.

The plan recomputes the joint material and output baskets after every addition:
shared SELL resources and BUY output volume are not counted once per line.
Whole-type limit prices are used. Runs shrink to whole-run resource, BUY, budget
and demand limits; tiny jobs below the selected minimums are not substituted.
Full BPC/contract and new BPO purchase prices count against first-cycle cash
profit and capital. Used BPC run cost is secondary economic profit only.
Delivery is charged once per whole cycle; freight volumes are shown, but travel
time, route feasibility and blueprint volume are unknown and not invented.

Demand cap uses the lower seven/thirty-calendar-day regional average, times
the chosen share (default 25%) and cycle days (minimum one day). At least five
active trade days in the last thirty are required. Missing/stale history does not
qualify. Regional history is not station demand or a sales guarantee. SELL net
is only an estimated competitor listing price after tax/broker fees.

The bounded greedy selection checks up to sixteen blueprint offers per type
and eighty qualified sources overall; it is not a global profit optimizer.
Skill capacity and currently free lines are shown separately. The plan assumes
occupied lines will become available; it never claims they are free now. Fewer
than nine valid lines are reported honestly. Main totals show full-cycle cash,
net BUY/SELL, last-job duration, slot-hours, common materials and Multibuy.
Changing parameters/budget marks the old plan stale and requires a new scan.
Manual purchases, logistics, job submissions and sales remain in EVE.

Blueprint copies have finite runs; see CCP's
[Copying](https://support.eveonline.com/hc/en-us/articles/203210602-Copying)
and [manufacturing](https://support.eveonline.com/hc/en-us/articles/203210292-Manufacturing)
documentation. No new SSO scopes, migrations or wallet mutations are introduced.
Historical UI descriptions below are superseded by this section for manual search.

## Current output valuation and complete order depth (1.1.12)

Finished-goods cards load public Jita IV–4 quotes for their actual output quantity
when visible, with at most two reads in flight and identical batches sharing a
quote. Automatic checks respect a five-minute/ESI-expiry cache; manual refresh
bypasses the application cache, not CCP's upstream cache. Source time and expiry
are retained instead of pretending cached prices were fetched just now.

BUY values a single limit sale of the entire batch at the lowest matched bid,
respecting available volume/minimum lots. If volume is insufficient, whole-batch
revenue and profit remain unknown. SELL uses the cheapest station ask as an
estimated listing price, not guaranteed demand or a sale-time promise.
Accounting determines sales tax when skills are available; otherwise 7.5% is an
explicit base assumption. SELL broker fee is an explicit base 3% assumption;
standings, relisting, transport and remote ranged BUY orders are not included.
Profit is net revenue minus recorded/labelled estimated batch cost. Unknown cost
does not hide market value and does not become zero. This is produced quantity,
not a claim about present Hangar inventory.

Market hub cards and finished-goods cards can open a modal with complete station
SELL and BUY price levels, quantities, cumulative quantities and order counts.
Equal-price orders are grouped, duplicate IDs excluded, SELL sorted ascending,
BUY descending. The first 25 levels are shown, with +50 pagination to the end;
the old four-level execution-only cutoff is removed. A search that hides all
production jobs now says so and offers a reset, without blaming SSO permissions.

## Automatic finished-goods costing (1.1.11)

Finished-goods cards now require only paid BPC price and the original purchased
run count. No contract ID, per-transaction quantity inputs, confirmation checkbox
or delivery/extras inputs in the normal workflow. BPO remains a reusable asset.
The price is shared between observed jobs of the same blueprint item, bounded
by the purchased run budget; unrelated copies do not inherit a guessed price.
Previously saved confirmed allocations/extras/contract IDs are preserved.

Recipe quantities are computed for the whole job using captured blueprint ME,
or explicitly labelled ME 0 if it is no longer known. Base Jita assumptions use
no structure material bonus. These quantities are estimates, not consumption
reported by ESI. Blueprint ME is retained by subsequent jobs-only captures;
older records are hydrated from the catalog without replacing saved history.

Automatic costing processes jobs in start-time order (including active jobs),
using the nearest personal market purchases before each job. Purchase quantities
are not debited twice; previously confirmed allocations take precedence. If
history covers only part of the requirement, uncovered quantity is valued at the
latest pre-job purchase price and labelled an estimate, not another real debit.
If there is no eligible purchase, current exact-station Jita SELL depth supplies
an explicitly labelled replacement-cost estimate. Whole-quantity limit pricing
applies, not a depth-weighted average. Missing depth/prices stay unknown.

Actual ESI job cost always wins and is charged once. Only if absent, an estimate
uses the current Jita manufacturing index and adjusted-price EIV with explicit
base assumptions: 0.25% facility tax + 4% SCC, Omega, no reductions. These are
configured estimation assumptions, not a claim about a particular historical
factory charge. Each material shows quantity, unit/total cost, source and date;
all assumptions are collapsed under details. No manual fee is required.

The current-market/SCI fallback may change when refreshed; it is never presented
as an exact historical cash expense. No fake wallet transactions or confirmed
consumption records are written by the automatic estimate.

## Background BPC monitor and manufactured-product ledger (1.1.10)

The initial manual cost-entry workflow below is superseded by 1.1.11 above.

The opt-in monitor runs in Electron main, independent of the selected tab/window.
It scans manufacturing recipes present in public contracts of the five trade-hub
regions. Only BPC purchases qualify; own blueprints, BPOs and held resources are
excluded. Exact full-market resource depth and BUY depth are checked. A separate
IndustryService instance keeps manual factory-quote state intact. Defaults: one
cycle every 10 minutes after the previous cycle; notifications require 10m ISK net
batch profit and 20% return on full upfront cash. Thresholds/budget are editable.
Stop aborts the current cooperative scan. Identity changes clear old results and
load the new character's independent configuration. No automatic spending.

Notifications are deduplicated by character/contract in persistent SQLite records,
with at most five new OS notices per cycle. Both monitor notification preference
and global Settings/OS permission apply. Clicking a notice opens Industry.
Fresh (<10 minute) BUY quotes are required, including for progressive notices;
the initial index may take a long time. ESI's public-contract cache (up to 30m)
and market cache (~5m) mean this is not a real-time contract-sniping guarantee.
Only selected/best source candidates per blueprint are shown, not all contracts
or a guaranteed globally optimal trade.

The new **Готовая продукция** tab is based on personal manufacturing jobs with
ESI `ready`/`delivered` status, not Hangar inventory. Completed jobs are requested
with `include_completed=true`, persisted on reads and captured in the background
every five minutes while authenticated. Cancelled/active jobs are not presented
as finished. History remains bounded by what ESI returns until observed locally.
Persisted job/cost/notification records survive market-cache clearing.

Job fee/taxes come from actual ESI `cost`; paid material unit prices come from
wallet transactions. ESI does not identify which purchase funded a job or expose
exact consumed material quantities there: the user confirms quantity allocations
from eligible earlier purchases. One purchase cannot be overallocated across jobs.
Paid BPC price/contract ID and original purchased run count are entered/confirmed
manually, never copied from a current listing as if already paid. BPC price is
consumed proportionally to job runs and shared-source run totals are bounded;
BPO acquisition is a reusable asset, not consumed production cost. Unknown costs
stay unknown until complete confirmation. Extras can include manual delivery cost.
This is a production-cost ledger, not proof of current inventory or sale proceeds.
Single-BPC contracts are supported for cost allocation; contract bundles require
separate manual investigation. No new OAuth scopes or plaintext tokens added.

## BUY-first decisions (1.1.9)

Default view requires positive BUY profit and sufficient materials, skills and
matching BUY depth for the selected batch. SELL competitor prices never influence
ranking or the primary ISK/hour. The decision helper chooses among independently
quoted one-run, hourly/total-profit boundary, full-copy and feasible batches using
the selected ranking and whole-batch budget (including the full contract/BPO cash).
ISK/hour divides the chosen batch's operating profit by that same batch's actual
manufacturing hours in one slot, not one-run time. BPO initial purchase remains a
separate reusable investment, with first-purchase profit explicitly shown. Own
copies with unknown acquisition cost are excluded from actionable recommendations.

Cards lead with chosen quantity/time, BUY net profit, hourly return and upfront
cash. One-run/full-copy/SELL comparisons are collapsed, detailed materials and
Multibuy remain available. "Показать все расчёты" reveals blocked/loss-making
positions with reasons; it does not promote SELL estimates into BUY earnings.
Current bids can disappear before manufacture completes; there is no reservation
or guarantee. Regional daily volume is displayed with batch/average-day share,
never interpreted as an estimated sale duration or station-specific demand.
Stale/unknown quote age and low-liquidity history remain explicit warnings.
Candidate search is bounded and is not a global optimum; mixed/historical costs
are revalued consistently across the already quoted candidate batches.

1.1.8 keeps cached contract indexing responsive: event-loop yields, throttled
progress and memoized unchanged source/production quotes. Purchase journal and
SSO permissions/persistence policy are unchanged.

## Automatic profitability and price accuracy (1.1.7)

Default production system is **Jita**. No output-quantity, blueprint-source,
sales-mode or profit-basis selector is needed. Public contract BPC/BPO, fresh
market BPO and available own blueprints are compared together using actual ME/TE
and one-run operating profit. Original purchase is a separate reusable investment;
copies consume their allocated purchase price, while the entire contract must be
paid upfront. Own-copy acquisition cost is unknown and explicitly excluded.

Each card compares **BUY now** and **SELL estimate** after fees for one complete
recipe run, the full BPC, and independently re-quoted resource/buyer-feasible
batches. A bounded search of price-boundary batches also proposes a profitable
BUY batch; maximum buyer volume can include joke bids and be unprofitable. This
is not a global optimum across all recipes/contracts. Original job planning is
bounded to 100000 runs, safe quantities and the 30-day job limit (one long run is
allowed). Capacity/BUY candidate selection uses full market stock; mixed-cost
views separately apply real held stock and deficit costs to each quoted batch.

**Multibuy correction:** all units of an ingredient are charged at the highest
ASK price needed for its full quantity, not the sum of independently priced
levels. Immediate one-shot selling similarly uses the lowest matched BID for
the full output. Buying/selling levels separately can improve execution, but
does not match a single immediate order. [CCP Multibuy explanation](https://www.eveonline.com/news/view/multibuy-all-the-things)
and [order matching rules](https://support.eveonline.com/hc/en-us/articles/203218932-Buy-and-Sell-Orders).

BUY demand includes station, same-system, regional and reachable jump-range
orders from the selected region. ASK materials remain at the exact selected
station. Every page is deduplicated; the oldest page's Last-Modified and Expires
identify the snapshot/cache boundary. Expired books are refreshed and all rows
re-quoted after long contract indexing, including SCI/adjusted prices and current
contract presence. No cache-busting circumvention of ESI. UI shows snapshot age
and warns after 10 minutes. ESI prices are not a real-time EVE quote.

Visible products lazily load regional realized trade history, two paced workers,
cache until ESI expiry. Missing/failed history is **unavailable**, not zero demand.
7/30-day averages include zero-trade calendar days and exclude unpublished days;
the history publication timestamp determines the last published day. Daily units,
30-day total, active days, last trade and stale/low-liquidity warnings are shown.
The Forge history is explicitly **not station-specific Jita sales** or a guarantee
of SELL completion. A minimum daily-volume filter applies to loaded cards.
Detailed material/Multibuy sections mount only when expanded.

## Material cost modes (1.1.6)

- **Только рынок** (default): full recipe cost from executable SELL depth; no wallet
  history required. The additional all-unknown historical panel is not shown.
- **Свои запасы + докупить с рынка**: direct personal Hangar snapshot at the selected
  location, not lifetime purchase volume. Stock with known purchase prices uses a
  weighted historical cost up to the recorded quantity. Unpriced held stock is valued
  at the current best SELL price (clearly marked), never treated as free. Exact missing
  quantity is independently quoted from the full order book, respecting minimum lots
  and available depth. This is not proportional scaling of the full-recipe average.
  Missing stock scope or changed location conservatively falls back to full market
  purchase, with a warning to rescan. Changing location needs a new snapshot/scan.
- **Только цены из истории покупок**: optional strict historical-price comparison;
  incomplete historical coverage is still unknown. This does not assert inventory.

Top-level profit, per-run cost, filters, counts, sorting, budget and capital use the
selected basis. Mixed capital is new purchases + job/transport/fees + blueprint cash,
not a second purchase of held materials. Mixed Multibuy automatically lists only
the deficit from the same stock snapshot. Readiness still requires valid blueprint,
skills/job constraints and sufficient whole-party BUY depth for instant sale.
Mixed readiness confirms only the requested batch; smaller batches must be re-quoted.

The journal and its nested **Показать список сделок** disclosure are both collapsed
by default. The period selector is also accessible outside the journal when needed.
Factory comparison still uses the full market recipe and says so in non-market modes.
Historical-purchase notes below describe the optional strict comparison, not the default.

The **Производство** tab calculates manufacturing opportunities for the currently
authorized EVE character. ESI cannot buy materials, install/deliver jobs, or place
market orders. Those actions remain in the EVE client.

## Sign-in

Normal sign-in retains the scopes previously registered for Fly Safe. The separate
**Подключить разрешения производства** button requests three additional read-only
permissions using the same PKCE, loopback, JWT validation and encrypted-token flow:

- `esi-skills.read_skills.v1`
- `esi-characters.read_blueprints.v1`
- `esi-industry.read_character_jobs.v1`

The owner of the registered OAuth application must enable these scopes in EVE
Developers. An `invalid_scope` response requires that configuration change, not a
VPN or a new password. Old refresh tokens remain usable for previous features.
Tokens never cross IPC. Active skill levels, not trained levels, drive calculations.
Missing/failed skill data disables scanning instead of assuming level zero.

## Nearby factories

On a completed opportunity, click **Сравнить фабрики · до 10 прыжков**.
The origin defaults to the material-buy hub; routes through high-sec are selected
by default. Distances use the official SDE stargate graph, not region membership
or straight-line distance. Disabling high-sec permits low/null-sec gate paths.
Ansiblex and wormholes are not included.

Candidates must appear in `/industry/facilities/` **and** have the SDE station
service `Factory` (14). The live public endpoint currently lists NPC stations,
not all private Upwell structures. Prices use current manufacturing SCI and the
last scan's skills/ME/TE/output/market snapshot, with explicit NPC assumptions:
0.25% EIV facility tax, zero structure material/time/SCI bonuses. SCC, clone and
batch transport cost remain as configured. Thus selecting NPC factories also
removes manually entered private-factory bonuses; it does not silently carry rigs
to an NPC station. Unknown tariffs and services are not invented.

The table shows material cost, full-batch installation cost, duration and profit.
Select a candidate, then re-scan to update all recipes under its system and NPC
assumptions. Confirm the actual job quotation, allowed product and docking in EVE.
Transport cost is not automatically increased with jumps. Private structures still
use manually entered system/tax/bonuses; complete private-factory discovery is not
supported by the available public ESI data.

## Scan assumptions and formulas

Choose material-buy hub, product-sell hub, production system and clone state.
The UI automatically quotes complete recipe runs and executable batches.
Legacy IPC `runs` / `productionQuantity` requests remain supported when
`autoPlan` is absent; output quantities round up to complete recipe runs.
Configure factory tax, combined material/time reductions, SCI cost reduction and
transport ISK per batch. Defaults: NPC-like 0.25% factory tax, SCC 4%, Omega,
no structure/rig/implant bonuses, transport zero. ESI does **not** confirm these
settings, manufacturing service availability, docking rights, or clone subscription.

- Materials: cheapest executable **sell** orders at the selected hub station,
  walking price levels, then using the whole-quantity Multibuy limit price.
- Output: eligible station/range **buy** orders, respecting volume and minimum
  quantity, then using the whole-quantity immediate-sale limit price.
  An incomplete fill makes complete-batch profit unknown.
- **BUY** shows immediate execution into existing bids. **SELL**
  estimates revenue using the lowest competing sell price, without pretending
  those orders are buyers or promising any sale deadline. The manually configured
  broker fee defaults to 3% and is subtracted from profit and included in upfront
  capital. Check the actual fee in EVE; standings, location and skills affect it.
  Relisting costs are not included. Both columns use the same immutable snapshot.
- New BPO: cheapest executable original on public NPC stations in the selected hub
  region(s). Five-region search is optional. Its exact location/system is displayed;
  delivery is not silently assumed free. This is not a universe-wide minimum.
- Public contract database (included with market/own sources): scans regional public item-exchange
  contracts and their contents, including contract-only recipes such as
  `'Packrat' Mobile Tractor Unit Blueprint` (33701). Uses actual ESI ME/TE and runs,
  not title text. UI calculates **one run, full BPC and feasible batches**.
  Acquisition cost and ME/TE material savings are compared through one-run profit.
  Excludes auctions, required-item exchanges and missing blueprint metadata.
  Packages are charged in full; other package items generate no assumed revenue.
  Docking/access, availability and contents must be checked in EVE before buying.
  This is a selected-region comparison, not a universe-wide minimum.
  Contracts with enough copy runs are preferred; insufficient copies retain cost
  details but do not produce a feasible whole-batch profit.
- Owned blueprint: an actual usable BPO/BPC with its ME/TE and remaining runs;
  busy, locked and Asset Safety blueprints are excluded. Copy acquisition/invention
  costs already incurred are not included; copies are not reusable indefinitely.
- Material quantity: `max(runs, ceil(round(base * runs * (1-ME/100) *
  (1-materialReduction/100), 2)))`. The copying limit is not a BPO manufacturing cap.
- Time: recipe time × runs × TE × configured time bonus × Industry × Advanced
  Industry × applicable directly-required science/manufacturing skill bonuses.
  Batches exceeding 30 days are marked unavailable (a single longer run is allowed).
  Skill prerequisites are checked recursively. Skill speed bonuses do not discount
  materials. Implant and facility reductions must be configured explicitly.
- EIV: full ME=0 recipe quantities × ESI **adjusted prices** × runs, not current
  sell prices or the material-discounted bill of materials.
- Installation: `EIV * (SCI * costBonus + factoryTax + SCC + alphaTax)`;
  Alpha adds 0.25% EIV. Missing adjusted prices or SCI are never treated as zero.
- Sales tax: `7.5% * (1 - 0.11 * activeAccountingLevel)`.
  Immediate market transactions have no order-creation broker fee.
- The capacity panel shows confirmed material and buy-order run bounds within
  the BPC or bounded BPO job. Combined limits
  re-check minimum lot sizes after applying BPC and 30-day constraints. An unusual
  non-monotonic minimum-lot book may yield a conservative lower bound (or zero)
  rather than a claim that an unquoted smaller batch can execute. Skills are
  checked separately. Smaller candidate batches are automatically re-priced,
  not scaled proportionally from a large batch.
- Repeat profit: filled buy revenue − sales tax − full material cost − installation
  − configured transport − broker fee (SELL only). First-batch profit also subtracts the full new BPO price.
  BPO payback is shown separately. Upfront cash includes purchasing a new BPO,
  even though the operating-profit table treats it as a reusable asset.
  BPC cost for one run is full contract price / available runs. Profit on each run
  includes this allocated cost, while upfront capital includes the full contract
  purchase. Unused runs remain in the copy; other bundled items are not valued as
  revenue. The default BPO per-run profit excludes buying the reusable asset;
  a separate first-run line subtracts its full acquisition price.

All calculations are visible by default, including losses and missing skills.
Cards show blueprint names, costs, required/current skills, unit sell/buy prices,
fees and a profit breakdown. Filters are optional; an empty filtered result offers
a one-click reset instead of implying no blueprints were calculated.

Contract indexing can take **tens of minutes on its first run**: ESI has no
type-filtered public-contract search, and The Forge had 35 list pages at verification.
Two bounded workers fetch contents; successful issued inventories are persisted
until contract expiry, while refreshed public lists determine current presence and
prices. The underlying ESI list may still be cached for up to 30 minutes. The next
scan only needs new item contents. Quotes stream immediately and are updated as
cheaper offers are found; regional minimum is confirmed only when indexing ends.
The stop button preserves read contents for resumption and labels quotes provisional.
Failures are not treated as a complete contract database.
Invalid/legacy blueprint ME/TE makes only that proposal unavailable, not the entire
index. Partial calculation rows are retained after a stop or failure and explicitly
labelled provisional. Character refresh does not erase scan errors. ESI 429 waits
respect Retry-After and remain cancellable. Regional order duration is informational:
zero is accepted, unusable metadata is null. Executable prices and volumes remain
strictly validated; no invented replacement prices or missing volumes are accepted.

Personal stock is only directly accessible non-singleton **Hangar** stacks at the
chosen location. Ship cargo, containers, Asset Safety and corporation stock are not
counted. Stock can be subtracted from the copied Multibuy shopping list, but economic
profit retains its full market replacement cost. Transport to the factory is manual.

Regional snapshots are paginated once, cached for five minutes and shared between
scans. Partial/failed snapshots are never cached or used as complete books. Page
progress and completed calculation batches stream to the UI. Results identify the
oldest market snapshot, character, SDE build and production system. Prices are a
snapshot, not a guarantee of available buyers after manufacture. Change parameters
and rescan; screen controls do not retroactively alter previous quotes.

The job monitor refreshes while the tab is open once a minute, respecting ESI cache
headers. Ready timers are estimates; paused jobs are never marked ready solely by
elapsed time. Switching characters clears private UI data and invalidates in-flight
results. The app does not provide background OS alerts when this tab is closed.

## Static data and rebuilding

Bundled catalog: official SDE build **3561556**, released **2026-09-30**, containing
4035 published single-product manufacturing recipes. It is built from CCP JSONL,
not example materials or fake prices. The catalog is bundled in the main process;
no 95 MB SDE download is needed at application startup.

To update the data, download/extract the official JSONL SDE and run:

```sh
node scripts/build-industry-catalog.mjs /path/to/extracted/sde
npm run typecheck
npx vitest run tests/industry.test.ts tests/industry-service.test.ts tests/industry-esi-client.test.ts tests/industry-ui.test.tsx
npm run package:mac
```

Sources: [CCP SDE](https://developers.eveonline.com/docs/services/static-data/),
[tax rules](https://support.eveonline.com/hc/en-us/articles/203218962-Broker-Fee-and-Sales-Tax),
[installation formula](https://www.eveonline.com/news/view/viridian-expansion-notes),
[SCC change](https://www.eveonline.com/news/view/patch-notes-version-21-06),
[ESI explorer](https://developers.eveonline.com/api-explorer).
# Журнал покупок и учётная себестоимость (1.1.5)

В производстве доступен личный журнал кошелька (`esi-wallet.read_character_wallet.v1`):
дата, материал/товар, покупка или продажа, количество, фактическая цена за единицу,
общая сумма сделки и ID места. Полученные страницы сохраняются атомарно в SQLite,
ключ — персонаж + ID сделки. Повторная синхронизация не создаёт дубли. Корпоративные
сделки исключены. Таблицы журнала отделены от кеша и не удаляются Clear cache.
При смене персонажа приватные результаты очищаются; ответ предыдущего чара
не сохраняется и не отображается. При ошибке ESI старый журнал остаётся с предупреждением.

При открытом разделе кошелёк запрашивается раз в минуту с соблюдением кеша ESI;
кнопка обновления делает условный запрос к ESI. Недоступные уже старые сделки API
не восстанавливает: локальный архив содержит только когда-либо полученные сделки.
Контрактные приобретения, добыча, подарки и корпоративные закупки здесь не учтены.

Для карточек выбирается дата начала покупок (UTC, по умолчанию последние 30 дней).
Средняя цена материала = сумма фактических покупок / купленное количество за период.
Стоимость материалов партии = количество по рецепту с ME/бонусами × средняя цена.
Если по любому материалу покупок меньше потребности партии, стоимость и прибыль
неизвестны — недостающий материал никогда не считается бесплатным.
Прибыль по покупкам рассчитывается независимо от глубины текущих sell-ордеров
материалов, но требует выручки на всю партию, известной цены запуска/комиссий и
достаточного числа запусков BPC. Учёт BPO/BPC соответствует выбранной базе прибыли.

Это **учётная оценка по вашим ценам**, не точная себестоимость конкретного задания:
ESI не связывает покупки с потреблёнными партиями. Остатки, расход в других заданиях,
перепродажа и перевозка не распределяются автоматически; одинаковые покупки могут
использоваться для сравнения нескольких планов. Средняя цена закупки не включает
отдельные комиссии размещения buy-ордеров. Чертёж, запуск, доставка, цена будущей
продажи и налог остаются расчётными. Основные фильтры/сортировка остаются по текущему
рынку; исторический расчёт показан отдельно. Валовые продажи журнала не называются
прибылью: это оборот до налогов, без привязки к произведённому товару.

Обрезанный JSON/сетевой сбой и 5xx при индексировании контрактов получают ограниченные
повторы с отменяемой паузой. Ошибки смысловой валидации не повторяются. После исчерпания
повторов сканирование остаётся предварительным; неуспешный ответ не кешируется и
минимальная цена не объявляется подтверждённой.
