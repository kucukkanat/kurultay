/** How and when the app alerts the person using it. Kept per browser: what suits a phone is not what suits a desktop. */

/** `all`: every incoming message makes a sound; `direct`: only what is for me (a mention, @all, a DM, a task, a reply in my thread). */
export const SOUND_SCOPES = ['all', 'direct'] as const
export type SoundScope = (typeof SOUND_SCOPES)[number]

export interface Prefs {
  sound: boolean
  /** 0..1, applied on top of the already gentle tones */
  volume: number
  scope: SoundScope
  /** also play (quietly) for the council I am looking at */
  soundWhenOpen: boolean
  vibrate: boolean
  /** a tappable banner for a message in a council I am not looking at */
  banners: boolean
  /** unread count in the tab title and a dot on the page icon */
  titleBadge: boolean
}

export const DEFAULT_PREFS: Readonly<Prefs> = { sound: true, volume: 0.5, scope: 'all', soundWhenOpen: true, vibrate: true, banners: true, titleBadge: true }

const isScope = (v: unknown): v is SoundScope => SOUND_SCOPES.some((s) => s === v)
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

/** Never trust storage: anything missing or malformed falls back to the default for that field alone. */
export function parsePrefs(input: unknown): Prefs {
  const o: Record<string, unknown> = typeof input === 'object' && input !== null ? { ...input } : {}
  const d = DEFAULT_PREFS
  return {
    sound: bool(o.sound, d.sound),
    volume: typeof o.volume === 'number' && Number.isFinite(o.volume) ? Math.min(1, Math.max(0, o.volume)) : d.volume,
    scope: isScope(o.scope) ? o.scope : d.scope,
    soundWhenOpen: bool(o.soundWhenOpen, d.soundWhenOpen),
    vibrate: bool(o.vibrate, d.vibrate),
    banners: bool(o.banners, d.banners),
    titleBadge: bool(o.titleBadge, d.titleBadge),
  }
}
