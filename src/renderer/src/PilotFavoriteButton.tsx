export interface PilotFavoriteCandidate {
  characterId: number
  name: string
  corporationName?: string | null
}

export function PilotFavoriteButton({
  pilot,
  favorite,
  pending = false,
  onToggle,
  className = ''
}: {
  pilot: PilotFavoriteCandidate
  favorite: boolean
  pending?: boolean
  onToggle: (pilot: PilotFavoriteCandidate) => void
  className?: string
}): React.JSX.Element {
  const action = favorite ? 'Remove' : 'Add'
  return (
    <button
      type="button"
      className={`pilot-favorite-button ${favorite ? 'favorite' : ''} ${className}`.trim()}
      aria-label={`${action} ${pilot.name} ${favorite ? 'from' : 'to'} the watchlist`}
      aria-pressed={favorite}
      title={favorite ? 'Dangerous contact: remove from favorites' : 'Add as a dangerous contact'}
      disabled={pending}
      onClick={() => onToggle(pilot)}
    >
      <span aria-hidden="true">{favorite ? '★' : '☆'}</span>
    </button>
  )
}
