import { readdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { APP_ORIGIN, type DaemonDirListing, type DaemonHealth, type DaemonSeatRequest, type DaemonSeatResult, type DaemonSnapshot } from '@kurultay/core'
import { PairingError, type Pairing } from './pairing'
import { SeatError } from './seat'
import { VERSION } from './version'

/**
 * The daemon's HTTP control server for the web app, on 127.0.0.1 only. Every request is checked before routing:
 * a loopback Host (DNS rebinding), an allowed Origin (other sites), then a paired Bearer token for anything but
 * health and pairing. See docs/security.md.
 */

/** What the control server needs from the daemon. */
export interface ControlApi {
  snapshot(): DaemonSnapshot
  seat(req: DaemonSeatRequest): Promise<DaemonSeatResult>
  removeAgent(instance: string): Promise<void>
  setWorkdir(instance: string, workdir: string): Promise<void>
  /** `sandbox` is checked by the daemon (it knows the protected paths), so the route passes it on as it came */
  setSandbox(instance: string, sandbox: unknown): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
}

export interface Control {
  port: number
  close(): Promise<void>
}

/** The hosted app plus the app's dev (5173) and preview (4173) servers. KURULTAY_ORIGINS adds more. */
export function defaultOrigins(): string[] {
  const extra = process.env.KURULTAY_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  return [APP_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173', ...extra]
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    /** machine-readable, sent next to the message */
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

// anything but a loopback Host is a DNS-rebinding attempt: a rebound page carries the attacker's host name
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const MAX_BODY = 256 * 1024

const cors = (origin: string) => ({
  'access-control-allow-origin': origin,
  vary: 'Origin',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  // Chrome's Private Network Access: a public page may reach a loopback address only when the server opts in
  'access-control-allow-private-network': 'true',
  'access-control-max-age': '600',
})

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        fail(new HttpError(413, 'too-large', 'request too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
        ok(parsed as Record<string, unknown>)
      } catch {
        fail(new HttpError(400, 'bad-json', 'body must be a JSON object'))
      }
    })
    req.on('error', fail)
  })
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'missing', `${what} is required`)
  return v
}

/** Folders only, no dotfiles, capped: enough for a picker without dumping a home folder into a web page. */
export function listDirs(path: string): DaemonDirListing {
  const dir = resolve(path || homedir())
  let dirs: string[]
  try {
    dirs = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 500)
  } catch {
    throw new HttpError(400, 'bad-path', `cannot open ${dir}`)
  }
  return { path: dir, parent: dirname(dir) === dir ? null : dirname(dir), dirs }
}

const asHttp = (err: unknown): HttpError => {
  if (err instanceof HttpError) return err
  if (err instanceof PairingError) return new HttpError(err.code === 'no-origin' ? 403 : 400, err.code, err.message)
  if (err instanceof SeatError) return new HttpError(err.code === 'paused' ? 409 : 400, err.code, err.message)
  return new HttpError(500, 'internal', err instanceof Error ? err.message : String(err))
}

export function startControl(api: ControlApi, pairing: Pairing, opts: { port: number; origins: readonly string[] }): Promise<Control> {
  const bearer = (req: IncomingMessage) => req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1]

  async function route(req: IncomingMessage, url: URL, origin: string | undefined): Promise<unknown> {
    const path = url.pathname
    if (req.method === 'GET' && path === '/health') {
      return { app: 'kurultay', version: VERSION, paired: pairing.pairedCount() > 0, paused: api.snapshot().paused } satisfies DaemonHealth
    }
    if (req.method === 'POST' && path === '/pair/request') return pairing.request(origin)
    if (req.method === 'GET' && path === '/pair/poll') return pairing.poll(str(url.searchParams.get('id'), 'id'))

    if (!pairing.verify(bearer(req))) throw new HttpError(401, 'unpaired', 'not paired')
    if (req.method === 'GET' && path === '/state') return api.snapshot()
    if (req.method === 'GET' && path === '/fs/list') return listDirs(url.searchParams.get('path') ?? '')
    if (req.method !== 'POST') throw new HttpError(404, 'not-found', 'not found')

    const body = await readBody(req)
    switch (path) {
      case '/seat':
        return api.seat({ ticket: str(body.ticket, 'ticket'), hosts: Array.isArray(body.hosts) ? body.hosts.map(String) : [], workdir: str(body.workdir, 'workdir'), sandbox: body.sandbox === true })
      case '/agents/remove':
        return api.removeAgent(str(body.instance, 'instance')).then(() => ({ ok: true }))
      case '/agents/workdir':
        return api.setWorkdir(str(body.instance, 'instance'), str(body.workdir, 'workdir')).then(() => ({ ok: true }))
      case '/agents/sandbox':
        return api.setSandbox(str(body.instance, 'instance'), body.sandbox).then(() => ({ ok: true }))
      case '/daemon/pause':
        return api.pause().then(() => ({ ok: true }))
      case '/daemon/resume':
        return api.resume().then(() => ({ ok: true }))
      case '/pair/revoke':
        pairing.revoke(bearer(req))
        return { ok: true }
    }
    throw new HttpError(404, 'not-found', 'not found')
  }

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin
    const send = (code: number, obj?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
      res.end(obj === undefined ? undefined : JSON.stringify(obj))
    }
    if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return send(403, { error: 'bad host', code: 'bad-host' })
    // no Origin: a local tool (curl), which still needs a token for anything that matters
    if (origin && !opts.origins.includes(origin)) return send(403, { error: 'origin not allowed', code: 'bad-origin' })
    const headers = origin ? cors(origin) : {}
    if (req.method === 'OPTIONS') return send(204, undefined, headers)
    try {
      send(200, await route(req, new URL(req.url ?? '/', 'http://localhost'), origin), headers)
    } catch (err) {
      const e = asHttp(err)
      send(e.status, { error: e.message, code: e.code }, headers)
    }
  })

  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address()
      ok({
        port: typeof addr === 'object' && addr ? addr.port : opts.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
            server.closeAllConnections()
          }),
      })
    })
  })
}
