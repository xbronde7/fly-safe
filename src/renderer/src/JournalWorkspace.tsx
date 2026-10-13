import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  EncounterJournalPage,
  EncounterPilotSearchPage,
  EncounterRecentQuery,
  EncounterPilotSearchQuery
} from '../../shared/encounter-journal'
import { EveTypeImage } from './EveTypeImage'

interface JournalApi {
  getEncounterJournal(query?: EncounterRecentQuery): Promise<EncounterJournalPage>
  searchEncounterPilot(query: EncounterPilotSearchQuery): Promise<EncounterPilotSearchPage>
  getEncounterCount(): Promise<number>
}

export function JournalWorkspace({
  api,
  active,
  onOpenPilot
}: {
  api: JournalApi | null
  active: boolean
  onOpenPilot: (pilot: { characterId: number; name: string; sourceLabel: string }) => void
}): React.JSX.Element {
  const [page, setPage] = useState<EncounterJournalPage | null>(null)
  const [count, setCount] = useState(0)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<EncounterPilotSearchPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wasActive = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    if (!api) return
    setLoading(true)
    setError(null)
    try {
      const [nextPage, nextCount] = await Promise.all([
        api.getEncounterJournal({ limit: 100 }),
        api.getEncounterCount()
      ])
      setPage(nextPage)
      setCount(nextCount)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (active && !wasActive.current) void load()
    wasActive.current = active
  }, [active, load])

  const runSearch = async (): Promise<void> => {
    if (!api || !query.trim()) return
    setLoading(true)
    setError(null)
    try {
      setSearch(await api.searchEncounterPilot({ name: query.trim(), limit: 100 }))
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setLoading(false)
    }
  }

  const snapshots = search
    ? search.matches.map((match) => ({ snapshot: match.snapshot, matchedPilot: match.matchedPilot }))
    : (page?.snapshots ?? []).map((snapshot) => ({ snapshot, matchedPilot: null }))

  return (
    <section className="journal-shell" aria-labelledby="journal-title">
      <div className="workspace-hero journal-hero">
        <div>
          <p className="eyebrow">Local memory · never sent to a server</p>
          <h1 id="journal-title">Encounter journal</h1>
          <p>Where you were, what you flew, and which pilots or hulls you saw in manual scans.</p>
        </div>
        <span className="journal-count"><b>{count}</b> snapshots</span>
      </div>

      <section className="journal-search-panel">
        <label>
          <span>Find a pilot you have encountered before</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void runSearch() }}
            placeholder="Pilot name"
          />
        </label>
        <button type="button" className="primary-button" disabled={!api || loading || !query.trim()} onClick={() => void runSearch()}>
          Find
        </button>
        {search && <button type="button" className="secondary-button" onClick={() => { setSearch(null); setQuery('') }}>Clear search</button>}
        <button type="button" className="secondary-button" disabled={!api || loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </section>

      {error && <div className="workspace-inline-error" role="alert">{error}</div>}

      {search && (
        <div className="journal-search-summary">
          Encounters found: <b>{search.matches.length}</b>{search.hasMore ? ' · more records exist' : ''}
        </div>
      )}

      <div className="journal-timeline">
        {snapshots.map(({ snapshot, matchedPilot }) => (
          <article className="journal-entry" key={`${snapshot.id}-${matchedPilot?.characterId ?? 'all'}`}>
            <div className="journal-time"><strong>{formatTime(snapshot.capturedAt)}</strong><small>{formatDay(snapshot.capturedAt)}</small></div>
            <div className="journal-system">
              <span>{snapshot.currentSystem.solarSystemId}</span>
              <strong>{snapshot.currentSystem.name ?? `System ${snapshot.currentSystem.solarSystemId}`}</strong>
              <small>{snapshot.ownShip?.typeName ?? 'Ship not recorded'}</small>
            </div>
            {snapshot.ownShip && <EveTypeImage typeId={snapshot.ownShip.typeId} variant="render" requestSize={128} className="journal-ship-image" />}
            <div className="journal-observation-counts">
              <span><b>{snapshot.localPilots.length}</b> Local</span>
              <span><b>{snapshot.dscanHulls.reduce((total, hull) => total + hull.count, 0)}</b> D-scan</span>
            </div>
            {matchedPilot && (
              <button
                type="button"
                className="journal-match"
                disabled={matchedPilot.characterId === null}
                onClick={() => matchedPilot.characterId && onOpenPilot({
                  characterId: matchedPilot.characterId,
                  name: matchedPilot.name,
                  sourceLabel: `Encounter journal · ${snapshot.currentSystem.name ?? snapshot.currentSystem.solarSystemId}`
                })}
              >
                <span>Matched pilot</span><strong>{matchedPilot.name}</strong><small>{matchedPilot.corporationName ?? 'Corporation unknown'}</small>
              </button>
            )}
            {!matchedPilot && snapshot.localPilots.length > 0 && (
              <div className="journal-pilot-chips">
                {snapshot.localPilots.slice(0, 12).map((pilot) => pilot.characterId ? (
                  <button key={pilot.characterId} type="button" onClick={() => onOpenPilot({
                    characterId: pilot.characterId!,
                    name: pilot.name,
                    sourceLabel: `Encounter journal · ${snapshot.currentSystem.name ?? snapshot.currentSystem.solarSystemId}`
                  })}>{pilot.name}</button>
                ) : <span key={pilot.name}>{pilot.name}</span>)}
                {snapshot.localPilots.length > 12 && <span>+{snapshot.localPilots.length - 12}</span>}
              </div>
            )}
            {snapshot.dscanHulls.length > 0 && (
              <div className="journal-hull-chips">
                {snapshot.dscanHulls.slice(0, 12).map((hull) => <span key={`${hull.typeId}-${hull.typeName}`}>{hull.typeName ?? hull.typeId} ×{hull.count}</span>)}
                {snapshot.dscanHulls.length > 12 && <span>+{snapshot.dscanHulls.length - 12}</span>}
              </div>
            )}
          </article>
        ))}
      </div>

      {!loading && snapshots.length === 0 && (
        <div className="workspace-empty">
          {search ? 'This pilot has not appeared in saved Local lists yet.' : 'The journal fills as you move and manually copy Local/D-scan.'}
        </div>
      )}
      <p className="data-boundary-note">The journal stays only on this computer for up to 30 days. ESI does not provide your movement history — Fly Safe records it while the app is running.</p>
    </section>
  )
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' }).format(Date.parse(value))
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short' }).format(Date.parse(value))
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error'
}
