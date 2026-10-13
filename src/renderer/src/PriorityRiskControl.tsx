import {
  RISK_PRIORITY_OPTIONS,
  type RiskPriority
} from '../../shared/priority-risk'

export function PriorityRiskControl({
  value,
  onChange,
  loaded,
  total,
  loading
}: {
  value: RiskPriority
  onChange: (value: RiskPriority) => void
  loaded: number
  total: number
  loading: boolean
}): React.JSX.Element {
  return (
    <label className="priority-risk-control">
      <span>Priority</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as RiskPriority)}
        aria-label="Risk priority by destroyed target type"
      >
        {RISK_PRIORITY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <small aria-live="polite">
        {value === 'general'
          ? 'overall PvP threat'
          : loading
            ? `last 10 kills: ${loaded}/${total}`
            : `target profiles: ${loaded}/${total}`}
      </small>
    </label>
  )
}
