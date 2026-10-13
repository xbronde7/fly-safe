import type { PilotWatchlistSoundId } from '../../shared/pilot-watchlist'

let audioContext: AudioContext | null = null
let activeUntil = 0

export interface PilotWatchlistAudioOptions {
  soundId?: PilotWatchlistSoundId | null
  /** Per-entry volume multiplier from 0 to 1. */
  volume?: number | null
  /** Global percentage retained for compatibility with the settings workspace. */
  globalVolumePercent?: number
}

interface AlertTone {
  delay: number
  frequency: number
  duration: number
  type: OscillatorType
}

const ALERT_TONES: Record<PilotWatchlistSoundId, readonly AlertTone[]> = {
  default: [
    { delay: 0, frequency: 880, duration: 0.12, type: 'square' },
    { delay: 0.16, frequency: 660, duration: 0.14, type: 'square' },
    { delay: 0.34, frequency: 880, duration: 0.18, type: 'square' }
  ],
  warning: [
    { delay: 0, frequency: 520, duration: 0.2, type: 'triangle' },
    { delay: 0.25, frequency: 520, duration: 0.24, type: 'triangle' }
  ],
  critical: [
    { delay: 0, frequency: 1040, duration: 0.1, type: 'sawtooth' },
    { delay: 0.13, frequency: 780, duration: 0.1, type: 'sawtooth' },
    { delay: 0.26, frequency: 1040, duration: 0.1, type: 'sawtooth' },
    { delay: 0.39, frequency: 780, duration: 0.2, type: 'sawtooth' }
  ],
  radar: [
    { delay: 0, frequency: 1260, duration: 0.08, type: 'sine' },
    { delay: 0.11, frequency: 920, duration: 0.1, type: 'sine' }
  ]
}

function getAudioContext(): AudioContext {
  if (audioContext) return audioContext
  audioContext = new AudioContext({ latencyHint: 'interactive' })
  return audioContext
}

/** Plays one short danger cue and coalesces concurrent requests. */
export async function playPilotWatchlistAlert(
  volumeOrOptions: number | PilotWatchlistAudioOptions = 100
): Promise<void> {
  await tryPlayPilotWatchlistAlert(volumeOrOptions)
}

/** Same cue with an explicit result for per-channel cooldown accounting. */
export async function tryPlayPilotWatchlistAlert(
  volumeOrOptions: number | PilotWatchlistAudioOptions = 100
): Promise<boolean> {
  const options = typeof volumeOrOptions === 'number'
    ? { globalVolumePercent: volumeOrOptions }
    : volumeOrOptions
  const globalVolume = normalizeAlertVolume(options.globalVolumePercent ?? 100)
  const entryVolume = options.volume === null || options.volume === undefined
    ? 1
    : Number.isFinite(options.volume)
      ? Math.min(1, Math.max(0, options.volume))
      : 1
  const volume = globalVolume * entryVolume
  if (volume === 0) return false
  const context = getAudioContext()
  if (context.state === 'suspended') await context.resume()
  if (context.currentTime < activeUntil) return false

  const start = context.currentTime + 0.015
  const tones = ALERT_TONES[options.soundId ?? 'default']
  activeUntil = start + Math.max(...tones.map((tone) => tone.delay + tone.duration)) + 0.06

  for (const tone of tones) {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const toneStart = start + tone.delay
    const toneEnd = toneStart + tone.duration

    oscillator.type = tone.type
    oscillator.frequency.setValueAtTime(tone.frequency, toneStart)
    gain.gain.setValueAtTime(0.0001, toneStart)
    gain.gain.exponentialRampToValueAtTime(0.12 * volume, toneStart + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start(toneStart)
    oscillator.stop(toneEnd + 0.01)
  }
  return true
}

export function normalizeAlertVolume(volumePercent: number): number {
  if (!Number.isFinite(volumePercent)) return 1
  return Math.min(1, Math.max(0, volumePercent / 100))
}
