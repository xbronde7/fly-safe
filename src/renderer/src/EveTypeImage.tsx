import { useState } from 'react'

type EveTypeImageVariant = 'icon' | 'render'
type EveImageSize = 32 | 64 | 128 | 256 | 512 | 1024
type ActiveImageSource = EveTypeImageVariant | 'failed'

interface EveTypeImageProps {
  typeId: number
  variant: EveTypeImageVariant
  requestSize: EveImageSize
  className?: string
}

interface ImageState {
  requestKey: string
  source: ActiveImageSource
}

function imageUrl(typeId: number, variant: EveTypeImageVariant, size: EveImageSize): string {
  return `https://images.evetech.net/types/${typeId}/${variant}?size=${size}`
}

/**
 * Decorative EVE type art. Ship renders retry as an icon before showing the
 * local placeholder because the Image Server does not render every type.
 */
export function EveTypeImage({
  typeId,
  variant,
  requestSize,
  className = ''
}: EveTypeImageProps): React.JSX.Element {
  const requestKey = `${typeId}:${variant}:${requestSize}`
  const [imageState, setImageState] = useState<ImageState>({
    requestKey,
    source: variant
  })
  const source = imageState.requestKey === requestKey ? imageState.source : variant
  const classes = ['eve-type-image', className, source === 'failed' ? 'image-failed' : '']
    .filter(Boolean)
    .join(' ')

  const handleError = (): void => {
    setImageState({
      requestKey,
      source: source === 'render' ? 'icon' : 'failed'
    })
  }

  return (
    <span className={classes} aria-hidden="true">
      {source === 'failed' ? (
        <span className="eve-type-image-fallback">◇</span>
      ) : (
        <img
          key={`${requestKey}:${source}`}
          src={imageUrl(typeId, source, requestSize)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={handleError}
        />
      )}
    </span>
  )
}
