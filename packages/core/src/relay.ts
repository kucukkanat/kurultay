import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { Emitter, now, randomHex } from './util'
import { KIND_WRAP, ROUTE_TAG, type NostrEvent } from './types'

export type RelayStatus = 'connecting' | 'open' | 'closed' | 'error'

export interface RelayInfo {
  url: string
  status: RelayStatus
  /** null = unknown yet, true = echoes ephemeral events, false = did not echo */
  ephemeral: boolean | null
  latencyMs?: number
  lastError?: string
  notices: string[]
}

export interface Frame {
  relay: string
  dir: 'in' | 'out'
  ts: number
  data: unknown[]
}

export type Filter = { kinds?: number[]; since?: number } & Record<string, unknown>

type PoolEvents = {
  event: { relay: string; sub: string; event: NostrEvent }
  frame: Frame
  status: RelayInfo
}

class RelayConn {
  ws?: WebSocket
  info: RelayInfo
  private backoff = 1000
  private closedByUs = false
  private pendingOk = new Map<string, (ok: boolean, msg: string) => void>()

  constructor(
    private pool: RelayPool,
    url: string,
  ) {
    this.info = { url, status: 'connecting', ephemeral: null, notices: [] }
  }

  connect() {
    this.closedByUs = false
    this.setStatus('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.info.url)
    } catch (err) {
      this.info.lastError = String(err)
      this.setStatus('error')
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 1000
      this.setStatus('open')
      for (const [id, filter] of this.pool.subs) this.send(['REQ', id, filter])
      this.flushOutbox()
      this.probe()
    }
    ws.onmessage = (msg) => this.onMessage(String(msg.data))
    ws.onerror = () => {
      this.info.lastError = 'websocket error'
    }
    ws.onclose = () => {
      this.setStatus('closed')
      for (const [, cb] of this.pendingOk) cb(false, 'connection closed')
      this.pendingOk.clear()
      if (!this.closedByUs) this.scheduleReconnect()
    }
  }

  private scheduleReconnect() {
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, 30_000)
    setTimeout(() => {
      if (!this.closedByUs) this.connect()
    }, delay)
  }

  close() {
    this.closedByUs = true
    for (const it of this.outbox.splice(0)) it.resolve({ ok: false, msg: 'closed' })
    try {
      this.ws?.close()
    } catch {}
  }

  setStatus(s: RelayStatus) {
    this.info.status = s
    this.pool._emitStatus(this.info)
  }

  send(data: unknown[]) {
    if (this.ws?.readyState !== 1) return false
    this.ws.send(JSON.stringify(data))
    this.pool._frame({ relay: this.info.url, dir: 'out', ts: Date.now(), data })
    return true
  }

  /** events published while the socket was down; flushed on (re)connect, dropped after 20 s */
  private outbox: { ev: NostrEvent; until: number; resolve: (r: { ok: boolean; msg: string }) => void }[] = []

  flushOutbox() {
    const t = Date.now()
    const items = this.outbox.splice(0)
    for (const it of items) {
      if (it.until < t) it.resolve({ ok: false, msg: 'not connected' })
      else this.publish(it.ev).then(it.resolve)
    }
  }

  publish(ev: NostrEvent): Promise<{ ok: boolean; msg: string }> {
    return new Promise((resolve) => {
      if (this.ws?.readyState !== 1) {
        if (this.closedByUs) return resolve({ ok: false, msg: 'closed' })
        this.outbox.push({ ev, until: Date.now() + 20_000, resolve })
        return
      }
      if (!this.send(['EVENT', ev])) return resolve({ ok: false, msg: 'not connected' })
      const timer = setTimeout(() => {
        this.pendingOk.delete(ev.id)
        resolve({ ok: true, msg: 'no OK received (assumed forwarded)' })
      }, 5000)
      this.pendingOk.set(ev.id, (ok, msg) => {
        clearTimeout(timer)
        this.pendingOk.delete(ev.id)
        resolve({ ok, msg })
      })
    })
  }

  private onMessage(raw: string) {
    let data: unknown[]
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    if (!Array.isArray(data)) return
    this.pool._frame({ relay: this.info.url, dir: 'in', ts: Date.now(), data })
    const [type] = data
    if (type === 'EVENT') {
      const [, sub, event] = data as [string, string, NostrEvent]
      if (sub === this.probeSub) return this.onProbe(event)
      this.pool._event(this.info.url, sub, event)
    } else if (type === 'OK') {
      const [, id, ok, msg] = data as [string, string, boolean, string]
      this.pendingOk.get(id)?.(ok, msg ?? '')
    } else if (type === 'NOTICE') {
      this.info.notices = [...this.info.notices.slice(-9), String(data[1])]
      this.pool._emitStatus(this.info)
    } else if (type === 'CLOSED') {
      const [, sub, msg] = data as [string, string, string]
      this.info.notices = [...this.info.notices.slice(-9), `CLOSED ${sub}: ${msg}`]
      this.pool._emitStatus(this.info)
    }
  }

  // --- ephemeral probe: publish a throwaway ephemeral event to ourselves and expect an echo
  private probeSub?: string
  private probeTag?: string
  private probeStart = 0
  private probeTimer?: ReturnType<typeof setTimeout>

  private probe() {
    this.probeSub = 'probe-' + randomHex(4)
    this.probeTag = randomHex(16)
    this.send(['REQ', this.probeSub, { kinds: [KIND_WRAP], ['#' + ROUTE_TAG]: [this.probeTag] }])
    const ev = finalizeEvent(
      { kind: KIND_WRAP, created_at: now(), tags: [[ROUTE_TAG, this.probeTag]], content: 'kurultay-probe' },
      generateSecretKey(),
    )
    this.probeStart = Date.now()
    // give the REQ a moment to register before publishing
    setTimeout(() => this.send(['EVENT', ev]), 150)
    this.probeTimer = setTimeout(() => {
      if (this.info.ephemeral === null) {
        this.info.ephemeral = false
        this.pool._emitStatus(this.info)
      }
      this.endProbe()
    }, 6000)
  }

  private onProbe(ev: NostrEvent) {
    if (ev.tags.some((t) => t[0] === ROUTE_TAG && t[1] === this.probeTag)) {
      this.info.ephemeral = true
      this.info.latencyMs = Date.now() - this.probeStart - 150
      this.pool._emitStatus(this.info)
      this.endProbe()
    }
  }

  private endProbe() {
    if (this.probeTimer) clearTimeout(this.probeTimer)
    if (this.probeSub) this.send(['CLOSE', this.probeSub])
    this.probeSub = undefined
  }
}

/** A tiny relay pool tuned for ephemeral traffic: no storage assumptions, full frame visibility. */
export class RelayPool extends Emitter<PoolEvents> {
  conns = new Map<string, RelayConn>()
  subs = new Map<string, Filter>()
  private seen = new Map<string, number>()

  constructor(relays: string[] = []) {
    super()
    this.setRelays(relays)
  }

  setRelays(relays: string[]) {
    const want = new Set(relays.map((r) => r.trim()).filter(Boolean))
    for (const [url, conn] of this.conns) {
      if (!want.has(url)) {
        conn.close()
        this.conns.delete(url)
      }
    }
    for (const url of want) {
      if (!this.conns.has(url)) {
        const conn = new RelayConn(this, url)
        this.conns.set(url, conn)
        conn.connect()
      }
    }
  }

  get relays(): RelayInfo[] {
    return [...this.conns.values()].map((c) => ({ ...c.info }))
  }

  subscribe(id: string, filter: Filter) {
    const prev = this.subs.get(id)
    if (prev && JSON.stringify(prev) === JSON.stringify(filter)) return
    this.subs.set(id, filter)
    for (const c of this.conns.values()) c.send(['REQ', id, filter])
  }

  unsubscribe(id: string) {
    if (!this.subs.delete(id)) return
    for (const c of this.conns.values()) c.send(['CLOSE', id])
  }

  async publish(ev: NostrEvent) {
    const results = await Promise.all(
      [...this.conns.values()].map(async (c) => ({ relay: c.info.url, ...(await c.publish(ev)) })),
    )
    return results
  }

  close() {
    for (const c of this.conns.values()) c.close()
    this.conns.clear()
  }

  /** @internal */
  _event(relay: string, sub: string, event: NostrEvent) {
    if (this.seen.has(event.id)) return
    this.seen.set(event.id, Date.now())
    if (this.seen.size > 5000) {
      const cutoff = Date.now() - 20 * 60_000
      for (const [id, t] of this.seen) if (t < cutoff) this.seen.delete(id)
    }
    this.emit('event', { relay, sub, event })
  }
  /** @internal */
  _frame(f: Frame) {
    this.emit('frame', f)
  }
  /** @internal */
  _emitStatus(info: RelayInfo) {
    this.emit('status', { ...info })
  }
}
