/** A minimal Blossom server (BUD-01/02) for tests and local development (Bun only). */
import { verifyEvent } from 'nostr-tools'
import { sha256Hex } from '../files'

export interface TestBlossom {
  url: string
  /** sha256 → blob, plus the key that uploaded it */
  blobs: Map<string, { data: Uint8Array; owner: string }>
  /** every blob ever received, for assertions about what the server could see */
  received: Uint8Array[]
  stop(): void
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }

function auth(req: Request, verb: string, sha: string): string | null {
  const h = req.headers.get('authorization')
  if (!h?.startsWith('Nostr ')) return null
  try {
    const ev = JSON.parse(atob(h.slice(6)))
    if (ev.kind !== 24242 || !verifyEvent(ev)) return null
    if (!ev.tags.some((t: string[]) => t[0] === 't' && t[1] === verb)) return null
    if (!ev.tags.some((t: string[]) => t[0] === 'x' && t[1] === sha)) return null
    return ev.pubkey
  } catch {
    return null
  }
}

export function startTestBlossom(port = 0): TestBlossom {
  const blobs = new Map<string, { data: Uint8Array; owner: string }>()
  const received: Uint8Array[] = []
  let base = ''
  const server = Bun.serve({
    port,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
      if (req.method === 'PUT' && url.pathname === '/upload') {
        const data = new Uint8Array(await req.arrayBuffer())
        const sha = await sha256Hex(data)
        const owner = auth(req, 'upload', sha)
        if (!owner) return new Response('unauthorized', { status: 401, headers: { ...cors, 'x-reason': 'bad auth' } })
        received.push(data)
        blobs.set(sha, { data, owner })
        return Response.json({ url: `${base}/${sha}`, sha256: sha, size: data.length, type: 'application/octet-stream', uploaded: Math.floor(Date.now() / 1000) }, { headers: cors })
      }
      const sha = url.pathname.slice(1).split('.')[0]
      if (req.method === 'GET') {
        const b = blobs.get(sha)
        return b ? new Response(b.data as BodyInit, { headers: cors }) : new Response('not found', { status: 404, headers: cors })
      }
      if (req.method === 'DELETE') {
        const b = blobs.get(sha)
        if (!b) return new Response('not found', { status: 404, headers: cors })
        if (auth(req, 'delete', sha) !== b.owner) return new Response('forbidden', { status: 403, headers: cors })
        blobs.delete(sha)
        return new Response(null, { status: 204, headers: cors })
      }
      return new Response('not found', { status: 404, headers: cors })
    },
  })
  base = `http://localhost:${server.port}`
  return { url: base, blobs, received, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const b = startTestBlossom(Number(process.env.PORT ?? 7778))
  console.log(`kurultay test blossom server listening on ${b.url}`)
}
