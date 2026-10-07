import { useEffect, useReducer } from 'preact/hooks'
import { DEFAULT_BLOSSOM, DEFAULT_RELAYS, Kurultay, noteRelay, relayHealth, type FailedRelays, type Frame, type RawRecord, type RelayHealth } from '@kurultay/core'
import { BrowserStorage, type Unlocked } from './identity'

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
}
export const toasts: Toast[] = []

let engine: Kurultay | null = null
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

export function toast(text: string, level: Toast['level'] = 'info') {
  const t = { id: Date.now() + Math.random(), level, text }
  toasts.push(t)
  bump()
  setTimeout(() => {
    const i = toasts.indexOf(t)
    if (i >= 0) toasts.splice(i, 1)
    bump()
  }, 5000)
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
  engine.on('message', ({ groupId, message }) => {
    if (typingMap[groupId]) delete typingMap[groupId][message.from]
  })
  engine.on('notice', (n) => toast(n.text, n.level))
  engine.on('approval', (a) => toast(a.kind === 'agent-join' ? `${a.requester.name} asks to join “${a.groupName}”` : `${a.requester.name} wants to join “${a.groupName}”`))
  await engine.start()
  ;(window as any).kurultay = engine // for the console / developer mode
  setInterval(bump, 15_000) // refresh presence and countdowns
  bump()
  return engine
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
export function unreadCount(e: Kurultay, groupId: string) {
  const since = readMap()[groupId] ?? 0
  const g = e.state.groups[groupId]
  if (!g) return 0
  return g.history.filter((m) => m.ts > since && m.from && m.from !== e.pubkey).length
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
