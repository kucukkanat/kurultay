import { useEffect, useReducer } from 'preact/hooks'
import { DEFAULT_BLOSSOM, DEFAULT_RELAYS, Kurultay, type Message, noteRelay, relayHealth, type FailedRelays, type Frame, type RawRecord, type RelayHealth } from '@kurultay/core'
import { BrowserStorage, type Unlocked } from './identity'
import { faviconHref, planAlert, previewOf, titleFor } from './notify'
import { DEFAULT_PREFS, parsePrefs, type Prefs } from './prefs'
import { audioContext, playSound, unlockAudio, type SoundKind } from './sound'
import { unreadSummary, type Unread } from './unread'

export const appUrl = new URL('./', location.href).href.replace(/#.*$/, '')

const RELAYS_KEY = 'kurultay:relays'
const DEV_KEY = 'kurultay:dev'
const READ_KEY = 'kurultay:read'

export function getRelays(): string[] {
  try {
    const r = JSON.parse(localStorage.getItem(RELAYS_KEY) || 'null')
    if (Array.isArray(r) && r.length) return r
  } catch {}
  return DEFAULT_RELAYS
}
export function setRelaysPref(r: string[]) {
  localStorage.setItem(RELAYS_KEY, JSON.stringify(r))
}

const BLOSSOM_KEY = 'kurultay:blossom'
export function getBlossom(): string[] {
  try {
    const r = JSON.parse(localStorage.getItem(BLOSSOM_KEY) || 'null')
    if (Array.isArray(r) && r.length) return r
  } catch {}
  return DEFAULT_BLOSSOM
}
export function setBlossomPref(r: string[]) {
  localStorage.setItem(BLOSSOM_KEY, JSON.stringify(r))
}

export const raw: RawRecord[] = []
export const frames: Frame[] = []
export interface Toast {
  id: number
  level: 'info' | 'warn' | 'error'
  text: string
  /** a banner for a message: tapping it opens this council */
  groupId?: string
}
export const toasts: Toast[] = []

let engine: Kurultay | null = null
/** Aborting it removes the page listeners and the refresh timer that startEngine set up. */
let page = new AbortController()
let failedRelays: FailedRelays = new Set()
let version = 0
const subs = new Set<() => void>()
let scheduled = false

function bump() {
  version++
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    syncChrome()
    for (const s of subs) s()
  })
}

/** Re-render the calling component whenever the engine changes. */
export function useStore() {
  const [, force] = useReducer((x: number, _a: void) => x + 1, 0)
  useEffect(() => {
    const f = () => force()
    subs.add(f)
    return () => void subs.delete(f)
  }, [])
  return version
}

export const typingMap: Record<string, Record<string, number>> = {}

export function dismissToast(id: number) {
  const i = toasts.findIndex((t) => t.id === id)
  if (i < 0) return // already gone (tapped before its timer ran out): nothing to repaint
  toasts.splice(i, 1)
  bump()
}

export function toast(text: string, level: Toast['level'] = 'info', groupId?: string) {
  const t = { id: Date.now() + Math.random(), level, text, groupId }
  toasts.push(t)
  bump()
  setTimeout(() => dismissToast(t.id), 5000)
}

// ------------------------------------------------------------------------------------------ attention and alerts

let openGroupId: string | null = null
/** The council on screen, set by the shell; together with visibility and focus it decides what counts as read. */
export function setOpenGroup(id: string | null) {
  if (id === openGroupId) return
  openGroupId = id
  // the council just opened stops counting as unread: refresh the tab title and icon now, not at the next message
  bump()
}
/** The person is looking at this council right now: it is open, the tab is visible and the window has focus. */
export function isAttending(groupId: string): boolean {
  return openGroupId === groupId && document.visibilityState === 'visible' && document.hasFocus()
}

const PREFS_KEY = 'kurultay:prefs'
export function getPrefs(): Prefs {
  try {
    return parsePrefs(JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'))
  } catch {
    return { ...DEFAULT_PREFS } // storage blocked or corrupt: the defaults still alert
  }
}
export function setPrefs(patch: Partial<Prefs>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(parsePrefs({ ...getPrefs(), ...patch })))
  } catch {
    toast('This browser blocks storage, so the notification settings cannot be saved', 'warn')
  }
  bump()
}
export function usePrefs(): Prefs {
  useStore()
  return getPrefs()
}

/** "Try it" buttons: a gesture, so this may also be what unlocks audio; `force` skips the gap between sounds. */
export async function previewSound(kind: SoundKind) {
  const ok = (await unlockAudio()) && playSound(audioContext(), kind, getPrefs().volume, { force: true })
  if (!ok) toast('This browser did not play the sound (no Web Audio, or audio still locked)', 'warn')
}

function alertFor(e: Kurultay, groupId: string, message: Message, forMe: boolean) {
  if (!message.from || message.from === e.pubkey) return
  const prefs = getPrefs()
  const plan = planAlert({ prefs, forMe, viewing: openGroupId === groupId, visible: document.visibilityState === 'visible', focused: document.hasFocus() })
  if (plan.sound) playSound(audioContext(), plan.sound, prefs.volume, { quiet: plan.quiet })
  // a longer pattern for what is for me, so a pocket can tell the two apart
  if (plan.vibrate && 'vibrate' in navigator) navigator.vibrate(forMe ? [30, 40, 30] : 20)
  if (plan.banner) {
    const g = e.state.groups[groupId]
    const from = e.displayName(groupId, message.from)
    const where = !g || g.roster.dm ? '' : ` in #${g.roster.name}`
    toast(`${from}${where}: ${previewOf(message.text, message.files)}`, 'info', groupId)
  }
}

const baseTitle = typeof document === 'undefined' ? 'Kurultay' : document.title
let lastIcon = ''
const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Tab title and page icon follow the unread totals; the icon is only swapped when it changes (Safari flickers). */
function syncChrome() {
  if (!engine) return
  const prefs = getPrefs()
  const { count, mentions } = unreadTotals(engine)
  document.title = titleFor(baseTitle, count, mentions, prefs.titleBadge)
  const shown = prefs.titleBadge ? count : 0
  const href = faviconHref(shown, mentions > 0, { dot: cssVar('--notify-dot'), mention: cssVar('--notify-dot-mention'), ring: cssVar('--notify-dot-ring') })
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link && href !== lastIcon) link.href = lastIcon = href
}

export async function startEngine(id: Unlocked) {
  engine = new Kurultay({
    sk: id.sk,
    name: id.record.name,
    kind: 'human',
    relays: getRelays(),
    blossom: getBlossom(),
    storage: new BrowserStorage(id.record.pubkey, id.aes),
    appUrl,
    card: { client: 'Kurultay web' },
  })
  engine.on('relay', (r) => {
    failedRelays = noteRelay(failedRelays, r)
  })
  for (const ev of ['change', 'relay', 'approval', 'message'] as const) engine.on(ev, bump)
  engine.on('raw', (r) => {
    raw.push(r)
    if (raw.length > 600) raw.splice(0, raw.length - 600)
    if (devMode()) bump()
  })
  engine.on('frame', (f) => {
    frames.push(f)
    if (frames.length > 600) frames.splice(0, frames.length - 600)
    if (devMode()) bump()
  })
  engine.on('typing', ({ groupId, from, on }) => {
    const m = (typingMap[groupId] ??= {})
    if (on) m[from] = Date.now() + 60_000
    else delete m[from]
    bump()
  })
  const e = engine
  engine.on('message', ({ groupId, message, forMe }) => {
    if (typingMap[groupId]) delete typingMap[groupId][message.from]
    alertFor(e, groupId, message, forMe)
  })
  // coming back to the tab or window is what marks the open council read, so re-render on it
  const { signal } = (page = new AbortController())
  for (const ev of ['focus', 'blur'] as const) addEventListener(ev, bump, { signal })
  document.addEventListener('visibilitychange', bump, { signal })
  // autoplay policy: audio stays locked until a gesture, so the first tap or key press unlocks it
  const unlock = () => {
    if (!getPrefs().sound) return
    void unlockAudio().then((ok) => {
      if (!ok) return
      removeEventListener('pointerdown', unlock, true)
      removeEventListener('keydown', unlock, true)
    })
  }
  addEventListener('pointerdown', unlock, { capture: true, signal })
  addEventListener('keydown', unlock, { capture: true, signal })
  engine.on('notice', (n) => toast(n.text, n.level))
  engine.on('approval', (a) => toast(a.kind === 'agent-join' ? `${a.requester.name} asks to join “${a.groupName}”` : `${a.requester.name} wants to join “${a.groupName}”`))
  await engine.start()
  ;(window as any).kurultay = engine // for the console / developer mode
  const refresh = setInterval(bump, 15_000) // refresh presence and countdowns
  signal.addEventListener('abort', () => clearInterval(refresh))
  bump()
  return engine
}

/** Undo startEngine. The app reloads instead (locking does); tests need it so nothing outlives their page. */
export async function stopEngine() {
  page.abort()
  await engine?.stop()
  engine = null
}

/** 'down' when no relay of the current pool answers; drives the top-bar offline badge. */
export function relayHealthNow(): RelayHealth {
  return engine ? relayHealth(engine.pool.relays, failedRelays) : 'ok'
}

export function useEngine(): Kurultay {
  if (!engine) throw new Error('engine not started')
  return engine
}

export function devMode() {
  return localStorage.getItem(DEV_KEY) === '1'
}
export function setDevMode(on: boolean) {
  localStorage.setItem(DEV_KEY, on ? '1' : '0')
  bump()
}

function readMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(READ_KEY) || '{}')
  } catch {
    return {}
  }
}
export function markRead(groupId: string) {
  const m = readMap()
  m[groupId] = Math.floor(Date.now() / 1000)
  localStorage.setItem(READ_KEY, JSON.stringify(m))
}
export function unreadCount(e: Kurultay, groupId: string): Unread {
  const g = e.state.groups[groupId]
  return g ? unreadSummary(g, readMap()[groupId] ?? 0, e.pubkey) : { count: 0, mentions: 0 }
}
/** Across every council except the one being looked at (it is about to be marked read). */
export function unreadTotals(e: Kurultay): Unread {
  return e
    .groups()
    .filter((g) => !isAttending(g.id))
    .map((g) => unreadCount(e, g.id))
    .reduce((a, b) => ({ count: a.count + b.count, mentions: a.mentions + b.mentions }), { count: 0, mentions: 0 })
}

const THREADS_KEY = 'kurultay:threads'

/** Replies seen per thread root, so a thread link can say how many are new. Per browser: it does not sync across devices. */
function seenThreads(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(THREADS_KEY) || '{}')
    return v && typeof v === 'object' ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}
export function threadSeen(rootId: string): number {
  return seenThreads()[rootId] ?? 0
}
/** An open thread counts as read only while the page is really in front of the person. */
export function markThreadSeen(rootId: string, replies: number) {
  if (document.visibilityState !== 'visible' || threadSeen(rootId) === replies) return
  try {
    localStorage.setItem(THREADS_KEY, JSON.stringify({ ...seenThreads(), [rootId]: replies }))
  } catch {
    return // storage blocked (private window, quota): the replies just keep showing as new
  }
  bump()
}
