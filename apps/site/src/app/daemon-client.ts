import { useEffect, useReducer } from 'preact/hooks'
import { DAEMON_PORT, type DaemonDirListing, type DaemonHealth, type DaemonSeatResult, type DaemonSnapshot, type PairPoll, type PairRequest, type SandboxConfig } from '@kurultay/core'
import { blocksLoopback, nextDelay, type DaemonStatus } from './daemon-search'

/**
 * The connection to the `kurultay` background service on this computer (its control server on 127.0.0.1). The page
 * looks for it, pairs once (the owner confirms a code in a terminal), then polls its state while the tab is visible.
 * When the browser cannot reach it, the `npx … join` command stays the way in.
 */

export interface DaemonClientState {
  readonly status: DaemonStatus
  readonly health?: DaemonHealth
  readonly snapshot?: DaemonSnapshot
  readonly pairing?: { readonly id: string; readonly code: string; readonly expiresAt: number }
  readonly error?: string
  readonly unsupportedBrowser: boolean
}

export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

const TOKEN_KEY = 'kurultay:daemon-token'
/** for a service started with KURULTAY_PORT */
export const PORT_KEY = 'kurultay:daemon-port'

let state: DaemonClientState = { status: 'searching', unsupportedBrowser: blocksLoopback(navigator.userAgent, location.protocol) }
const subs = new Set<() => void>()
const set = (patch: Partial<DaemonClientState>) => {
  state = { ...state, ...patch }
  subs.forEach((s) => s())
}

export const daemonState = (): DaemonClientState => state

// Storage can be blocked (private mode, site data off): only then is the token kept in memory, for this page's lifetime.
// A copy kept while storage works would outlive its removal there (unpaired in another tab, site data cleared).
let memoryToken: string | null = null
const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const token = () => read(TOKEN_KEY) ?? memoryToken
const saveToken = (t: string | null) => {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
    memoryToken = null
  } catch {
    memoryToken = t
  }
}
const port = () => {
  const p = Number(read(PORT_KEY))
  return Number.isInteger(p) && p > 0 ? p : DAEMON_PORT
}

async function request<T>(path: string, init: { body?: unknown; auth?: boolean; timeout?: number } = {}): Promise<T> {
  const t = init.auth === false ? null : token()
  const res = await fetch(`http://127.0.0.1:${port()}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeout ?? 8000),
  })
  const json: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = (typeof json === 'object' && json !== null ? json : {}) as { error?: unknown; code?: unknown }
    throw new DaemonHttpError(res.status, typeof e.code === 'string' ? e.code : undefined, typeof e.error === 'string' ? e.error : `the service answered ${res.status}`)
  }
  return json as T
}

let misses = 0

async function checkPairing(p: NonNullable<DaemonClientState['pairing']>) {
  try {
    const r = await request<PairPoll>(`/pair/poll?id=${encodeURIComponent(p.id)}`, { auth: false })
    if (r.status === 'approved') {
      saveToken(r.token)
      set({ status: 'unpaired', pairing: undefined, error: undefined })
      await look()
    } else if (r.status === 'expired' || Date.now() > p.expiresAt) set({ status: 'unpaired', pairing: undefined, error: 'The code expired. Ask for a new one.' })
  } catch {
    set({ status: 'searching', pairing: undefined })
  }
}

async function look() {
  if (state.status === 'pairing' && state.pairing) return checkPairing(state.pairing)
  try {
    const health = await request<DaemonHealth>('/health', { auth: false, timeout: 1500 })
    misses = 0
    if (!token()) return set({ status: 'unpaired', health, snapshot: undefined })
    set({ status: 'connected', health, snapshot: await request<DaemonSnapshot>('/state'), error: undefined })
  } catch (err) {
    // 401: the service forgot this browser (revoked, or reinstalled), so ask to pair again
    if (err instanceof DaemonHttpError && err.status === 401) {
      saveToken(null)
      return set({ status: 'unpaired', snapshot: undefined })
    }
    misses++
    if (state.status !== 'searching' || state.health) set({ status: 'searching', health: undefined, snapshot: undefined })
  }
}

let timer: ReturnType<typeof setTimeout> | undefined
/** How many watchers (components showing the service, or callers of watchDaemon) are still around. */
let watchers = 0
const schedule = () => {
  clearTimeout(timer)
  if (watchers === 0) return
  timer = setTimeout(() => void (document.visibilityState === 'hidden' ? schedule() : look().finally(schedule)), nextDelay(state.status, misses))
}
/** Look now (after an action, or back on the tab) instead of waiting for the next poll. */
export const refresh = () => look().finally(schedule)
const onVisible = () => {
  if (document.visibilityState !== 'visible') return
  misses = 0
  void refresh()
}

/**
 * Keep looking for the service while something shows it. Started by the first component that shows it, not on page load:
 * reaching 127.0.0.1 can make the browser ask about local network access, which only people adding agents should see.
 * Counted, so one watcher stopping leaves the others polling, and the last one to stop ends the polling and its listener.
 */
export function watchDaemon(): () => void {
  if (watchers++ === 0) {
    document.addEventListener('visibilitychange', onVisible)
    void refresh()
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (--watchers > 0) return
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }
}

/** Re-render the calling component whenever the connection changes (and start looking for the service). */
export function useDaemon(): DaemonClientState {
  const [, force] = useReducer((x: number, _a: void) => x + 1, 0)
  useEffect(() => {
    const f = () => force()
    subs.add(f)
    const stop = watchDaemon()
    return () => {
      subs.delete(f)
      stop()
    }
  }, [])
  return state
}

/** Ask the service for a pairing code; the page shows it and the owner confirms it with `kurultay pair <code>`. */
export async function startPairing() {
  try {
    const r = await request<PairRequest>('/pair/request', { body: {}, auth: false })
    set({ status: 'pairing', pairing: { id: r.id, code: r.code, expiresAt: Date.now() + r.expiresIn * 1000 }, error: undefined })
    schedule()
  } catch (err) {
    set({ error: (err as Error).message })
  }
}

export const cancelPairing = () => set({ status: 'unpaired', pairing: undefined })

/** Forget this browser on both sides. */
export async function unpair() {
  await request('/pair/revoke', { body: {} }).catch(() => {})
  saveToken(null)
  set({ status: 'unpaired', snapshot: undefined })
}

/** Every command refreshes the state, so the page shows its effect without waiting for the next poll. */
const command = <T>(path: string, body: unknown, timeout = 30_000) => request<T>(path, { body, timeout }).finally(() => void refresh())

export const daemon = {
  seat: (ticket: string, hosts: readonly string[], workdir: string, sandbox: boolean) => command<DaemonSeatResult>('/seat', { ticket, hosts, workdir, sandbox }, 60_000),
  /** the service checks the grants again and refuses with "Not allowed: …" naming every bad field */
  setSandbox: (instance: string, sandbox: SandboxConfig) => command('/agents/sandbox', { instance, sandbox }),
  removeAgent: (instance: string) => command('/agents/remove', { instance }),
  setWorkdir: (instance: string, workdir: string) => command('/agents/workdir', { instance, workdir }),
  pause: () => command('/daemon/pause', {}),
  resume: () => command('/daemon/resume', {}),
  listDir: (path = '') => request<DaemonDirListing>(`/fs/list?path=${encodeURIComponent(path)}`),
}
