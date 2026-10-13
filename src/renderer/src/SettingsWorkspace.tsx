import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CURRENT_SYSTEM_POLL_RANGE,
  DEFAULT_UI_SETTINGS,
  PILOT_CONTEXT_POLL_RANGE,
  SOUND_VOLUME_RANGE,
  UI_SCALE_RANGE,
  uiSettingsEqual,
  type UiDensity,
  type UiSettings,
  type UiSettingsApi,
  type UiSettingsSnapshot
} from '../../shared/ui-settings'
import { playPilotWatchlistAlert } from './watchlist-audio'
import { applyUiSettingsToDocument } from './ui-settings-dom'
import './settings-workspace.css'

export interface SettingsWorkspaceProps {
  api: SettingsWorkspaceApi | null
  onApplied?: (settings: UiSettings) => void
  onTestSound?: (volumePercent: number) => void | Promise<void>
}

export type SettingsWorkspaceApi = UiSettingsApi

export function SettingsWorkspace({
  api,
  onApplied = applyUiSettingsToDocument,
  onTestSound = playPilotWatchlistAlert
}: SettingsWorkspaceProps): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UiSettingsSnapshot | null>(null)
  const [draft, setDraft] = useState<UiSettings>({ ...DEFAULT_UI_SETTINGS })
  const [loading, setLoading] = useState(Boolean(api))
  const [saving, setSaving] = useState(false)
  const [testingSound, setTestingSound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!api) {
      setLoading(false)
      setError('Settings storage is unavailable in this build.')
      return
    }

    let active = true
    setLoading(true)
    setError(null)
    void api.getUiSettings()
      .then((nextSnapshot) => {
        if (!active) return
        setSnapshot(nextSnapshot)
        setDraft(nextSnapshot.settings)
        onApplied(nextSnapshot.settings)
      })
      .catch((caught) => {
        if (active) setError(`Could not load settings: ${errorMessage(caught)}`)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [api, onApplied])

  const dirty = useMemo(
    () => snapshot !== null && !uiSettingsEqual(snapshot.settings, draft),
    [draft, snapshot]
  )

  const updateDraft = useCallback(<Key extends keyof UiSettings>(
    key: Key,
    value: UiSettings[Key]
  ): void => {
    setNotice(null)
    const next: UiSettings = { ...draft, [key]: value }
    setDraft(next)
    onApplied(next)
  }, [draft, onApplied])

  const save = async (): Promise<void> => {
    if (!api || !dirty || saving) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const nextSnapshot = await api.updateUiSettings({ patch: draft })
      setSnapshot(nextSnapshot)
      setDraft(nextSnapshot.settings)
      onApplied(nextSnapshot.settings)
      setNotice('Settings saved and applied.')
    } catch (caught) {
      setError(`Could not save settings: ${errorMessage(caught)}`)
    } finally {
      setSaving(false)
    }
  }

  const testSound = async (): Promise<void> => {
    if (testingSound || draft.soundVolumePercent === 0) return
    setTestingSound(true)
    setError(null)
    try {
      await onTestSound(draft.soundVolumePercent)
      setNotice(`Sound check: ${draft.soundVolumePercent}%`)
    } catch (caught) {
      setError(`Could not play sound: ${errorMessage(caught)}`)
    } finally {
      setTestingSound(false)
    }
  }

  const restoreDefaults = (): void => {
    const defaults = { ...DEFAULT_UI_SETTINGS }
    setDraft(defaults)
    onApplied(defaults)
    setError(null)
    setNotice('Default values are ready. Select Save to apply them.')
  }

  return (
    <section className="settings-panel" aria-labelledby="settings-title">
      <header className="settings-heading">
        <div>
          <p className="eyebrow">Fly Safe · local settings</p>
          <h1 id="settings-title">Interface settings</h1>
          <p>Scale, density, volume, and safe ESI polling frequency.</p>
        </div>
        <span className="settings-storage-state">
          <span aria-hidden="true" />
          {api ? 'Stored on this device' : 'Storage unavailable'}
        </span>
      </header>

      {loading ? (
        <div className="settings-loading" role="status">Loading settings…</div>
      ) : (
        <div className="settings-grid">
          <article className="settings-card settings-support-card">
              <div className="settings-card-heading">
                <div>
                  <h2>Support Fly Safe</h2>
                  <p>
                    Fly Safe is free to use. Donations help fund maintenance and future updates.
                  </p>
                </div>
              </div>
              <div className="settings-support-links">
                <a href="https://donatty.com/xbronde" target="_blank" rel="noreferrer">
                  Donate via Donatty
                </a>
                <span>BTC wallet</span>
                <code>13mQGzbcyaW5RtfzMvL4dxtzANHnAS2zbC</code>
              </div>
            </article>

          <SettingsRange
            id="ui-scale"
            title="Interface scale"
            description="Scales the entire interface, including tables and small labels."
            value={draft.scalePercent}
            range={UI_SCALE_RANGE}
            valueLabel={`${draft.scalePercent}%`}
            disabled={!api || saving}
            onChange={(value) => updateDraft('scalePercent', value)}
          />

          <article className="settings-card">
            <div className="settings-card-heading">
              <div>
                <h2>Card density</h2>
                <p>Compact mode reduces spacing without shrinking text.</p>
              </div>
            </div>
            <div className="settings-segmented" role="radiogroup" aria-label="Interface density">
              <DensityButton
                density="comfortable"
                current={draft.density}
                disabled={!api || saving}
                onChange={(density) => updateDraft('density', density)}
              >
                Comfortable
              </DensityButton>
              <DensityButton
                density="compact"
                current={draft.density}
                disabled={!api || saving}
                onChange={(density) => updateDraft('density', density)}
              >
                Compact
              </DensityButton>
            </div>
          </article>

          <SettingsRange
            id="sound-volume"
            title="Alert volume"
            description="Master volume for watched-contact sounds and background alerts."
            value={draft.soundVolumePercent}
            range={SOUND_VOLUME_RANGE}
            valueLabel={draft.soundVolumePercent === 0 ? 'Muted' : `${draft.soundVolumePercent}%`}
            disabled={!api || saving}
            action={(
              <button
                type="button"
                className="settings-test-button"
                disabled={!api || saving || testingSound || draft.soundVolumePercent === 0}
                onClick={() => void testSound()}
              >
                {testingSound ? 'Playing…' : 'Test sound'}
              </button>
            )}
            onChange={(value) => updateDraft('soundVolumePercent', value)}
          />

          <article className="settings-card settings-background-card">
            <div className="settings-card-heading">
              <div>
                <h2>Background operation</h2>
                <p>Alerts keep working when the main window is out of focus.</p>
              </div>
            </div>
            <div className="settings-toggle-list">
              <SettingsToggle
                checked={draft.backgroundNotificationsEnabled}
                disabled={!api || saving}
                title="System notifications"
                description="Show R2Z2 and watched-contact alerts above other applications."
                onChange={(enabled) => updateDraft('backgroundNotificationsEnabled', enabled)}
              />
              <SettingsToggle
                checked={draft.minimizeToTray}
                disabled={!api || saving}
                title="Minimize to tray"
                description="The close button hides Fly Safe; quit remains in the tray menu."
                onChange={(enabled) => updateDraft('minimizeToTray', enabled)}
              />
            </div>
          </article>

          <SettingsRange
            id="system-poll-interval"
            title="Current-system refresh"
            description="Location and current ship. A 20-second minimum prevents unnecessary ESI 429s."
            value={draft.currentSystemPollSeconds}
            range={CURRENT_SYSTEM_POLL_RANGE}
            valueLabel={formatDuration(draft.currentSystemPollSeconds)}
            disabled={!api || saving}
            onChange={(value) => updateDraft('currentSystemPollSeconds', value)}
          />

          <SettingsRange
            id="context-poll-interval"
            title="Pilot-context refresh"
            description="Contacts and friendly fleet change less often; safe minimum is one minute."
            value={draft.pilotContextPollSeconds}
            range={PILOT_CONTEXT_POLL_RANGE}
            valueLabel={formatDuration(draft.pilotContextPollSeconds)}
            disabled={!api || saving}
            onChange={(value) => updateDraft('pilotContextPollSeconds', value)}
          />
        </div>
      )}

      {error && <div className="settings-message error" role="alert">{error}</div>}
      {notice && <div className="settings-message success" role="status">{notice}</div>}

      <footer className="settings-actions">
        <div>
          <strong>{dirty ? 'Unsaved changes' : 'All changes saved'}</strong>
          <small>
            {snapshot?.updatedAt
              ? `Last saved: ${formatTimestamp(snapshot.updatedAt)}`
              : 'Using safe default values'}
          </small>
        </div>
        <button
          type="button"
          className="settings-reset-button"
          disabled={!api || loading || saving}
          onClick={restoreDefaults}
        >
          Defaults
        </button>
        <button
          type="button"
          className="settings-save-button"
          disabled={!api || loading || saving || !dirty}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
    </section>
  )
}

function SettingsRange({
  id,
  title,
  description,
  value,
  range,
  valueLabel,
  disabled,
  action,
  onChange
}: {
  id: string
  title: string
  description: string
  value: number
  range: { min: number; max: number; step: number }
  valueLabel: string
  disabled: boolean
  action?: React.ReactNode
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <article className="settings-card">
      <div className="settings-card-heading">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <output htmlFor={id}>{valueLabel}</output>
      </div>
      <div className="settings-range-row">
        <span>{range.min}</span>
        <input
          id={id}
          type="range"
          min={range.min}
          max={range.max}
          step={range.step}
          value={value}
          disabled={disabled}
          aria-label={title}
          aria-valuetext={valueLabel}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span>{range.max}</span>
        {action}
      </div>
    </article>
  )
}

function DensityButton({
  density,
  current,
  disabled,
  onChange,
  children
}: {
  density: UiDensity
  current: UiDensity
  disabled: boolean
  onChange: (density: UiDensity) => void
  children: React.ReactNode
}): React.JSX.Element {
  const selected = density === current
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={selected ? 'selected' : ''}
      disabled={disabled}
      onClick={() => onChange(density)}
    >
      {children}
    </button>
  )
}

function SettingsToggle({
  checked,
  disabled,
  title,
  description,
  onChange
}: {
  checked: boolean
  disabled: boolean
  title: string
  description: string
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label className="settings-toggle">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <i aria-hidden="true" />
    </label>
  )
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} sec`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder} sec`
}

function formatTimestamp(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
