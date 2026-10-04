/**
 * A minimal in-process Nostr relay for tests and local development (Bun only).
 * Ephemeral kinds (20000-29999) are forwarded to live subscribers and never stored.
 */
import type { NostrEvent } from '../types'

type Filter = Record<string, unknown> & { kinds?: number[]; ids?: string[]; authors?: string[] }

function matches(f: Filter, ev: NostrEvent) {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.ids && !f.ids.includes(ev.id)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(v)) continue
    const name = k.slice(1)
    if (!ev.tags.some((t) => t[0] === name && (v as string[]).includes(t[1]))) return false
  }
  return true
}

export interface TestRelay {
  url: string
  port: number
  /** every event ever received, for assertions about what the relay could see */
  observed: NostrEvent[]
  stored: NostrEvent[]
  stop(): void
}

export function startTestRelay(port = 0): TestRelay {
  type WS = { send(s: string): void; data: { subs: Map<string, Filter> } }
  const clients = new Set<WS>()
  const observed: NostrEvent[] = []
  const stored: NostrEvent[] = []
  const server = Bun.serve({
    port,
    fetch(req, srv) {
      if ((srv as any).upgrade(req, { data: { subs: new Map<string, Filter>() } })) return
      return new Response('kurultay test relay')
    },
    websocket: {
      open(ws) {
        clients.add(ws as unknown as WS)
      },
      close(ws) {
        clients.delete(ws as unknown as WS)
      },
      message(ws: any, raw) {
        let msg: unknown[]
        try {
          msg = JSON.parse(String(raw))
        } catch {
          return
        }
        const [type] = msg
        if (type === 'REQ') {
          const [, id, ...filters] = msg as [string, string, ...Filter[]]
          ws.data.subs.set(id, filters[0] ?? {})
          for (const ev of stored) if (filters.some((f) => matches(f, ev))) ws.send(JSON.stringify(['EVENT', id, ev]))
          ws.send(JSON.stringify(['EOSE', id]))
        } else if (type === 'CLOSE') {
          ws.data.subs.delete(msg[1] as string)
        } else if (type === 'EVENT') {
          const ev = msg[1] as NostrEvent
          observed.push(ev)
          const ephemeral = ev.kind >= 20000 && ev.kind < 30000
          if (!ephemeral) stored.push(ev)
          ws.send(JSON.stringify(['OK', ev.id, true, '']))
          for (const c of clients) {
            for (const [id, f] of c.data.subs) if (matches(f, ev)) c.send(JSON.stringify(['EVENT', id, ev]))
          }
        }
      },
    },
  })
  return {
    url: `ws://localhost:${server.port}`,
    port: server.port!,
    observed,
    stored,
    stop: () => server.stop(true),
  }
}

if (import.meta.main) {
  const r = startTestRelay(Number(process.env.PORT ?? 7777))
  console.log(`kurultay test relay listening on ${r.url}`)
}
