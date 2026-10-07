import type { Prefs } from './prefs'
import type { SoundKind } from './sound'

/** What is true about the moment a message arrives. */
export interface AlertContext {
  prefs: Prefs
  /** the engine's `forMe`: a mention, @all, a DM, a task, a reply in my thread */
  forMe: boolean
  /** the council it arrived in is the one open on screen */
  viewing: boolean
  /** the tab is visible */
  visible: boolean
  /** the window has focus */
  focused: boolean
}

export interface AlertPlan {
  sound: SoundKind | null
  /** the sound is for the council I am already looking at, so it is played quieter */
  quiet: boolean
  vibrate: boolean
  /** a tappable banner inside the app */
  banner: boolean
}

/**
 * How to tell the person about one incoming message. Sound, vibration and banners are layers that add up: looking at the
 * council needs the least, being away from it the most. "Attending" is the same rule that decides when a council is read.
 */
export function planAlert(c: AlertContext): AlertPlan {
  const attending = c.viewing && c.visible && c.focused
  const audible = c.prefs.sound && (c.prefs.scope === 'all' || c.forMe) && (!attending || c.prefs.soundWhenOpen)
  return {
    sound: audible ? (c.forMe ? 'mention' : 'message') : null,
    quiet: attending,
    vibrate: audible && !attending && c.prefs.vibrate,
    // a banner in a hidden tab would be gone before anyone saw it; the title and icon cover that case
    banner: !attending && c.visible && c.prefs.banners,
  }
}

/** The tab title: the count first so it survives a narrow tab, and a dot when something is for me. */
export function titleFor(base: string, unread: number, mentions: number, enabled: boolean): string {
  if (!enabled || unread <= 0) return base
  return `${mentions > 0 ? '● ' : ''}(${unread > 99 ? '99+' : unread}) ${base}`
}

/** One line for a banner: the text without Markdown, or the names of the attachments when there is no text. */
export function previewOf(text: string, files: readonly { name: string }[] = [], max = 90): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/[*_`>#~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const line = flat || (files.length ? `Attached: ${files.map((f) => f.name).join(', ')}` : '')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export interface FaviconColors {
  dot: string
  mention: string
  /** the ring that separates the dot from the mark */
  ring: string
}

/** The flame mark from index.html; the brand colours are the mark's own, so they stay fixed in both themes. */
const MARK = `<circle cx='16' cy='16' r='15' fill='#8e2c1f'/><path d='M16 7c3 4 5 6.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.6 1 2.5 2 3 0-3 .5-5.5 1-8.5z' fill='#f3c46a'/>`

/** The page icon, with a dot when something is unread (the mention colour when it is for me). */
export function faviconHref(unread: number, mention: boolean, colors: FaviconColors): string {
  const dot = unread > 0 ? `<circle cx='25' cy='7' r='6.5' fill='${mention ? colors.mention : colors.dot}' stroke='${colors.ring}' stroke-width='2'/>` : ''
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>${MARK}${dot}</svg>`)}`
}
