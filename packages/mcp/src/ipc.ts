import { request, createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { configRoot } from './instance'

/** Local-only channel between CLI sessions (MCP servers) and the background daemon. */
function socketPath() {
  if (process.platform === 'win32') return `\\\\.\\pipe\\kurultay-${(process.env.USERNAME || 'user').replace(/\W/g, '')}`
  return join(configRoot(), 'daemon.sock')
}

function call<T>(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socketPath(), path, method, headers: { 'content-type': 'application/json' }, timeout: timeoutMs }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode && res.statusCode >= 400) reject(new Error(parsed.error ?? `daemon error ${res.statusCode}`))
          else resolve(parsed)
        } catch (err) {
          reject(err)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('daemon timeout')))
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

/** Instances the running daemon manages, or null when no daemon is reachable. */
export async function daemonAgents(): Promise<string[] | null> {
  if (process.platform !== 'win32' && !existsSync(socketPath())) return null
  try {
    const r = await call<{ agents: { instance: string }[] }>('GET', '/agents', undefined, 1500)
    return r.agents.map((a) => a.instance)
  } catch {
    return null
  }
}

export function daemonStatus() {
  return call<{ pid: number; version: string; agents: { instance: string; name: string; mode: string; workdir: string; host: string; online: boolean; running: boolean; lastRun?: string; councils: string[] }[] }>('GET', '/agents', undefined, 1500)
}

export function daemonCall(instance: string, tool: string, args: unknown) {
  return call<{ content: { type: 'text'; text: string }[]; isError?: boolean }>('POST', '/call', { instance, tool, args })
}

export function daemonPost<T = unknown>(path: string, body: unknown = {}) {
  return call<T>('POST', path, body, 5000)
}

export function daemonGet<T>(path: string) {
  return call<T>('GET', path, undefined, 5000)
}

export interface DaemonHandlers {
  agents(): unknown
  get(path: string): unknown
  call(instance: string, tool: string, args: unknown, signal: AbortSignal): Promise<unknown>
  post(path: string, body: unknown): Promise<unknown>
}

export function serveIpc(h: DaemonHandlers): Server {
  const path = socketPath()
  if (process.platform !== 'win32') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    if (existsSync(path)) unlinkSync(path)
  }
  const srv = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      const ac = new AbortController()
      res.on('close', () => ac.abort())
      try {
        if (req.method === 'GET' && req.url === '/agents') return send(200, h.agents())
        if (req.method === 'GET') return send(200, h.get(req.url ?? ''))
        const parsed = body ? JSON.parse(body) : {}
        if (req.method === 'POST' && req.url === '/call') return send(200, await h.call(parsed.instance, parsed.tool, parsed.args, ac.signal))
        if (req.method === 'POST') return send(200, await h.post(req.url ?? '', parsed))
        send(404, { error: 'not found' })
      } catch (err) {
        send(500, { error: (err as Error).message })
      }
    })
  })
  // only this user may drive the agents
  srv.listen(path, () => {
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  })
  return srv
}
