import { useEffect, useReducer } from 'preact/hooks'
import { DEFAULT_RELAYS, Kurultay, type Frame, type RawRecord } from '@kurultay/core'
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

export const raw: RawRecord[] = []
export const frames: Frame[] = []
export interface Toast {
  id: number
  level: 'info' | 'warn' | 'error'
  text: string
}
export const toasts: Toast[] = []

let engine: Kurultay | null = null
let version = 0
const subs = new Set<() => void>()
let scheduled = false

export function bump() {
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
    storage: new BrowserStorage(id.record.pubkey, id.aes),
    appUrl,
    card: { client: 'Kurultay web' },
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
  setInterval(bump, 15_000) // refresh presence and countdowns
  bump()
  return engine
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
