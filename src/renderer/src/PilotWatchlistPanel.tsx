import { useEffect, useState } from 'react'
import {
  PILOT_WATCHLIST_ALERT_SOURCES,
  getPilotWatchlistAlertSources,
  getPilotWatchlistEntityId,
  getPilotWatchlistEntityKey,
  getPilotWatchlistEntityType,
  getPilotWatchlistSeverity,
  getSupportedPilotWatchlistAlertSources,
  type PilotWatchlistAdvancedPatch,
  type PilotWatchlistAlertSource,
  type PilotWatchlistEntityKey,
  type PilotWatchlistEntityType,
  type PilotWatchlistEntry,
  type PilotWatchlistSeverity,
  type PilotWatchlistSoundId,
  type PilotWatchlistUpsertRequest
} from '../../shared/pilot-watchlist'
import type { PilotFavoriteCandidate } from './PilotFavoriteButton'

const ENTITY_LABELS: Record<PilotWatchlistEntityType, string> = {
  character: 'Pilot',
  corporation: 'Corporation',
  alliance: 'Alliance'
}

const SEVERITY_LABELS: Record<PilotWatchlistSeverity, string> = {
  watch: 'Watch',
  danger: 'Dangerous',
  critical: 'Critical'
}

const SOURCE_LABELS: Record<PilotWatchlistAlertSource, string> = {
  local: 'Local',
  dscan: 'D-scan',
  'system-killmail': 'System killmail',
  r2z2: 'R2Z2'
}

function formatAddedAt(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(new Date(timestamp))
}

function contactWord(count: number): string {
  return count === 1 ? 'contact' : 'contacts'
}

function parseTags(value: string): string[] {
  const tags: string[] = []
  const seen = new Set<string>()
  for (const rawTag of value.split(',')) {
    const tag = rawTag.trim()
    const key = tag.toLocaleLowerCase('en-US')
    if (tag && !seen.has(key)) {
      seen.add(key)
      tags.push(tag)
    }
  }
  return tags.slice(0, 20)
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function WatchlistContactCard({
  entry,
  pending,
  onOpenPilot,
  onUpdate,
  onAdvancedUpdate,
  onRemove
}: {
  entry: PilotWatchlistEntry
  pending: boolean
  onOpenPilot: (entry: PilotWatchlistEntry) => void
  onUpdate: (entry: PilotWatchlistEntry, patch: {
    note?: string | null
    alertSoundEnabled?: boolean
  }) => void
  onAdvancedUpdate?: (entry: PilotWatchlistEntry, patch: PilotWatchlistAdvancedPatch) => void
  onRemove: (entry: PilotWatchlistEntry) => void
}): React.JSX.Element {
  const entityType = getPilotWatchlistEntityType(entry)
  const entityId = getPilotWatchlistEntityId(entry)
  const initialSeverity = getPilotWatchlistSeverity(entry)
  const initialSources = getPilotWatchlistAlertSources(entry)
  const initialTags = entry.tags ?? []
  const initialTagsKey = JSON.stringify(initialTags)
  const initialSourcesKey = JSON.stringify(initialSources)
  const initialSoundId = entry.soundId ?? null
  const initialVolume = entry.volume ?? null
  const initialCooldown = entry.cooldownSeconds ?? 60
  const [note, setNote] = useState(entry.note ?? '')
  const [severity, setSeverity] = useState<PilotWatchlistSeverity>(initialSeverity)
  const [tagsText, setTagsText] = useState(initialTags.join(', '))
  const [alertSources, setAlertSources] = useState<PilotWatchlistAlertSource[]>(initialSources)
  const [soundId, setSoundId] = useState<PilotWatchlistSoundId | null>(initialSoundId)
  const [volume, setVolume] = useState<number | null>(initialVolume)
  const [cooldownSeconds, setCooldownSeconds] = useState(initialCooldown)

  useEffect(() => setNote(entry.note ?? ''), [entry.note])
  useEffect(() => setSeverity(getPilotWatchlistSeverity(entry)), [entry.severity])
  useEffect(() => setTagsText(initialTags.join(', ')), [initialTagsKey])
  useEffect(() => setAlertSources(initialSources), [initialSourcesKey])
  useEffect(() => setSoundId(entry.soundId ?? null), [entry.soundId])
  useEffect(() => setVolume(entry.volume ?? null), [entry.volume])
  useEffect(() => setCooldownSeconds(entry.cooldownSeconds ?? 60), [entry.cooldownSeconds])

  const normalizedNote = note.trim()
  const noteChanged = normalizedNote !== (entry.note ?? '')
  const tags = parseTags(tagsText)
  const advancedChanged = (
    severity !== initialSeverity ||
    !sameStrings(tags, initialTags) ||
    !sameStrings(alertSources, initialSources) ||
    soundId !== initialSoundId ||
    volume !== initialVolume ||
    cooldownSeconds !== initialCooldown
  )
  const nameId = `watchlist-contact-name-${entityType}-${entityId}`
  const advancedDisabled = pending || !onAdvancedUpdate
  const supportedSources = getSupportedPilotWatchlistAlertSources(entityType)

  const toggleSource = (source: PilotWatchlistAlertSource, enabled: boolean): void => {
    setAlertSources((current) => enabled
      ? PILOT_WATCHLIST_ALERT_SOURCES.filter((candidate) => (
          candidate === source || current.includes(candidate)
        ))
      : current.filter((candidate) => candidate !== source))
  }

  return (
    <article
      className={`watchlist-contact-card watchlist-severity-${severity}`}
      aria-labelledby={nameId}
    >
      <div className="watchlist-contact-main">
        <span className="watchlist-star" aria-hidden="true">★</span>
        <div className="watchlist-contact-identity">
          {entityType === 'character' ? (
            <button id={nameId} type="button" onClick={() => onOpenPilot(entry)}>
              {entry.name}
            </button>
          ) : (
            <strong id={nameId}>{entry.name}</strong>
          )}
          <small>
            {ENTITY_LABELS[entityType]} · ID {entityId}
            {entityType === 'character'
              ? ` · ${entry.corporationName ?? 'corporation unknown'}`
              : ''}
          </small>
        </div>
        <span className={`watchlist-danger-badge severity-${severity}`}>
          {SEVERITY_LABELS[severity]}
        </span>
        <small className="watchlist-added-at">Added {formatAddedAt(entry.addedAt)}</small>
      </div>

      {initialTags.length > 0 ? (
        <div className="watchlist-tag-strip" aria-label={`Tags for ${entry.name}`}>
          {initialTags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
      ) : null}

      <div className="watchlist-contact-controls">
        <label className="watchlist-note-field">
          <span>Note</span>
          <input
            type="text"
            value={note}
            maxLength={500}
            placeholder="For example: camper, scout, dropper…"
            aria-label={`Note for ${entry.name}`}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="watchlist-note-save"
          disabled={pending || !noteChanged}
          aria-label={`Save note for ${entry.name}`}
          onClick={() => onUpdate(entry, { note: normalizedNote || null })}
        >
          Save
        </button>
        <label className="watchlist-entry-sound">
          <input
            type="checkbox"
            checked={entry.alertSoundEnabled}
            disabled={pending}
            aria-label={`Sound for ${entry.name}`}
            onChange={(event) => onUpdate(entry, {
              alertSoundEnabled: event.target.checked
            })}
          />
          <span>Contact sound</span>
        </label>
        <button
          type="button"
          className="watchlist-remove-button"
          disabled={pending}
          aria-label={`Remove ${entry.name} from watchlist`}
          onClick={() => onRemove(entry)}
        >
          Remove
        </button>
      </div>

      <div className="watchlist-rule-editor" aria-label={`Alert rules for ${entry.name}`}>
        <label>
          <span>Level</span>
          <select
            value={severity}
            disabled={advancedDisabled}
            aria-label={`Danger level for ${entry.name}`}
            onChange={(event) => setSeverity(event.target.value as PilotWatchlistSeverity)}
          >
            <option value="watch">Watch</option>
            <option value="danger">Dangerous</option>
            <option value="critical">Critical</option>
          </select>
        </label>
        <label className="watchlist-tags-field">
          <span>Comma-separated tags</span>
          <input
            value={tagsText}
            maxLength={659}
            disabled={advancedDisabled}
            aria-label={`Tags for ${entry.name}`}
            placeholder="camper, cyno, logistics"
            onChange={(event) => setTagsText(event.target.value)}
          />
        </label>
        <label>
          <span>Sound</span>
          <select
            value={soundId ?? 'inherit'}
            disabled={advancedDisabled}
            aria-label={`Sound for ${entry.name}`}
            onChange={(event) => setSoundId(
              event.target.value === 'inherit'
                ? null
                : event.target.value as PilotWatchlistSoundId
            )}
          >
            <option value="inherit">Global</option>
            <option value="default">Default</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
            <option value="radar">Radar</option>
          </select>
        </label>
        <label>
          <span>Volume</span>
          <select
            value={volume === null ? 'inherit' : String(volume)}
            disabled={advancedDisabled}
            aria-label={`Volume for ${entry.name}`}
            onChange={(event) => setVolume(
              event.target.value === 'inherit' ? null : Number(event.target.value)
            )}
          >
            <option value="inherit">Global</option>
            <option value="0.25">25%</option>
            <option value="0.5">50%</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
          </select>
        </label>
        <label>
          <span>Repeat, sec.</span>
          <input
            type="number"
            min={0}
            max={86400}
            step={5}
            value={cooldownSeconds}
            disabled={advancedDisabled}
            aria-label={`Alert cooldown for ${entry.name}`}
            onChange={(event) => setCooldownSeconds(Math.max(0, Number(event.target.value) || 0))}
          />
        </label>

        <fieldset className="watchlist-source-rules" disabled={advancedDisabled}>
          <legend>Alert sources</legend>
          {PILOT_WATCHLIST_ALERT_SOURCES.map((source) => (
            <label key={source}>
              <input
                type="checkbox"
                checked={alertSources.includes(source)}
                disabled={!supportedSources.includes(source)}
                aria-label={`${SOURCE_LABELS[source]} for ${entry.name}`}
                onChange={(event) => toggleSource(source, event.target.checked)}
              />
              <span>
                {SOURCE_LABELS[source]}
                {!supportedSources.includes(source) ? ' · pilots only' : ''}
              </span>
            </label>
          ))}
        </fieldset>
        {entityType !== 'character' ? (
          <small className="watchlist-source-note">
            Corporations and alliances support Local and R2Z2: D-scan and the history aggregate
            do not contain reliable pilot affiliation.
          </small>
        ) : null}

        <button
          type="button"
          className="watchlist-rules-save"
          disabled={advancedDisabled || !advancedChanged}
          aria-label={`Save rules for ${entry.name}`}
          onClick={() => onAdvancedUpdate?.(entry, {
            severity,
            tags,
            alertSources,
            soundId,
            volume,
            cooldownSeconds
          })}
        >
          Save rules
        </button>
      </div>
    </article>
  )
}

function WatchlistEntityCreator({
  onCreate
}: {
  onCreate: (request: PilotWatchlistUpsertRequest) => void
}): React.JSX.Element {
  const [entityType, setEntityType] = useState<PilotWatchlistEntityType>('character')
  const [entityId, setEntityId] = useState('')
  const [name, setName] = useState('')
  const parsedId = Number(entityId)
  const valid = Number.isSafeInteger(parsedId) && parsedId > 0 && name.trim().length > 0

  return (
    <div className="watchlist-entity-creator" aria-label="Add an entity to the watchlist">
      <strong>Add manually</strong>
      <select
        value={entityType}
        aria-label="Entity type"
        onChange={(event) => setEntityType(event.target.value as PilotWatchlistEntityType)}
      >
        <option value="character">Pilot</option>
        <option value="corporation">Corporation</option>
        <option value="alliance">Alliance</option>
      </select>
      <input
        value={entityId}
        inputMode="numeric"
        placeholder="EVE ID"
        aria-label="Entity ID"
        onChange={(event) => setEntityId(event.target.value)}
      />
      <input
        value={name}
        maxLength={128}
        placeholder="Name"
        aria-label="Entity name"
        onChange={(event) => setName(event.target.value)}
      />
      <button
        type="button"
        disabled={!valid}
        onClick={() => {
          onCreate({
            characterId: parsedId,
            entityType,
            entityId: parsedId,
            name: name.trim(),
            severity: 'danger',
            alertSoundEnabled: true
          })
          setEntityId('')
          setName('')
        }}
      >
        Add
      </button>
    </div>
  )
}

export function PilotWatchlistPanel({
  entries,
  loading,
  pendingEntityKeys,
  soundEnabled,
  onSoundEnabledChange,
  onTestSound,
  onOpenPilot,
  onUpdate,
  onAdvancedUpdate,
  onCreateEntity,
  onRemove,
  eveContactImportCount,
  onImportEveContacts,
  importingEveContacts = false
}: {
  entries: readonly PilotWatchlistEntry[]
  loading: boolean
  pendingEntityKeys: ReadonlySet<PilotWatchlistEntityKey>
  soundEnabled: boolean
  onSoundEnabledChange: (enabled: boolean) => void
  onTestSound: () => void
  onOpenPilot: (entry: PilotWatchlistEntry) => void
  onUpdate: (entry: PilotWatchlistEntry, patch: {
    note?: string | null
    alertSoundEnabled?: boolean
  }) => void
  onAdvancedUpdate?: (entry: PilotWatchlistEntry, patch: PilotWatchlistAdvancedPatch) => void
  onCreateEntity?: (request: PilotWatchlistUpsertRequest) => void
  onRemove: (entry: PilotWatchlistEntry) => void
  eveContactImportCount?: number
  onImportEveContacts?: () => void
  importingEveContacts?: boolean
}): React.JSX.Element {
  return (
    <section className="watchlist-panel" aria-labelledby="watchlist-title">
      <header className="watchlist-heading">
        <div>
          <p className="eyebrow">Local watchlist · Watchlist 2.0</p>
          <h1 id="watchlist-title">Dangerous contacts</h1>
          <p>
            Pilots, corporations, and alliances with separate rules for Local,
            D-scan, system killmails, and R2Z2. The list stays only on this device.
          </p>
        </div>
        <div className="watchlist-sound-controls">
          <label>
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={(event) => onSoundEnabledChange(event.target.checked)}
            />
            <span>Sound alert</span>
          </label>
          <button type="button" onClick={onTestSound} disabled={!soundEnabled}>
            Test sound
          </button>
        </div>
      </header>

      {eveContactImportCount !== undefined && onImportEveContacts ? (
        <div className="watchlist-eve-import">
          <div>
            <strong>EVE contacts</strong>
            <small>
              Available for local import: {eveContactImportCount}. Nothing will change in EVE.
            </small>
          </div>
          <button
            type="button"
            disabled={importingEveContacts || eveContactImportCount <= 0}
            onClick={onImportEveContacts}
          >
            {importingEveContacts ? 'Importing…' : 'Import contacts'}
          </button>
        </div>
      ) : null}

      {onCreateEntity ? <WatchlistEntityCreator onCreate={onCreateEntity} /> : null}

      <div className="watchlist-summary" aria-live="polite">
        <strong>{entries.length}</strong>
        <span>{contactWord(entries.length)} on the list</span>
        <small>Repeated alerts use an individual cooldown.</small>
      </div>

      {loading ? (
        <div className="watchlist-empty" role="status">Loading watchlist…</div>
      ) : entries.length === 0 ? (
        <div className="watchlist-empty">
          <span aria-hidden="true">☆</span>
          <strong>The list is empty</strong>
          <p>Open Local or a pilot's full card and press the star.</p>
        </div>
      ) : (
        <div className="watchlist-contact-list">
          {entries.map((entry) => {
            const entityId = getPilotWatchlistEntityId(entry)
            const entityType = getPilotWatchlistEntityType(entry)
            return (
              <WatchlistContactCard
                key={`${entityType}:${entityId}`}
                entry={entry}
                pending={pendingEntityKeys.has(getPilotWatchlistEntityKey(entry))}
                onOpenPilot={onOpenPilot}
                onUpdate={onUpdate}
                onAdvancedUpdate={onAdvancedUpdate}
                onRemove={onRemove}
              />
            )
          })}
        </div>
      )}
    </section>
  )
}

export function toFavoriteCandidate(entry: PilotWatchlistEntry): PilotFavoriteCandidate {
  return {
    characterId: getPilotWatchlistEntityId(entry),
    name: entry.name,
    corporationName: entry.corporationName
  }
}
