import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kurultay, MemoryStorage, newSecretKey, type DaemonSnapshot } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'

// a real daemon, a real relay, real `kurultay pair` subprocesses: the browser's side is plain fetch with an Origin header
setDefaultTimeout(30_000)

const relay = startTestRelay(0)
const cli = join(import.meta.dir, '../src/cli.ts')
const ORIGIN = 'http://app.test'
// realpath: macOS tmpdir is a symlink and the daemon reports resolved folders
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kurultay-control-')))
const bin = join(home, 'bin')
const work = join(home, 'project')
for (const d of [bin, work, join(home, '.codex')]) mkdirSync(d)
// seating asks the CLI whether a Kurultay plugin is installed; a stand-in keeps the test off any real Codex
writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n')
chmodSync(join(bin, 'codex'), 0o755)
const kHome = join(home, '.config/kurultay')
const env = { ...process.env, HOME: home, KURULTAY_HOME: kHome, KURULTAY_NO_KEYCHAIN: '1', KURULTAY_RELAYS: relay.url, KURULTAY_MACHINE: 'testbox', KURULTAY_PORT: '0', KURULTAY_ORIGINS: ORIGIN, PATH: `${bin}:${process.env.PATH}` }

let daemon: ReturnType<typeof Bun.spawn> | undefined
let owner: Kurultay
let base = ''
let token = ''

const until = async (cond: () => unknown | Promise<unknown>, ms = 10_000) => {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await Bun.sleep(100)
  }
}

interface Reply {
  status: number
  headers: Headers
  json: Record<string, unknown>
}
async function http(path: string, opts: { body?: unknown; method?: string; token?: string | null; origin?: string | null; host?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN
  const t = opts.token === undefined ? token : opts.token
  if (t) headers.authorization = `Bearer ${t}`
  if (opts.host) headers.host = opts.host
  const res = await fetch(base + path, { method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'), headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  return { status: res.status, headers: res.headers, json: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}
const state = async () => (await http('/state')).json as unknown as DaemonSnapshot

const kurultay = async (...args: string[]) => {
  const p = Bun.spawn(['bun', cli, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { out, err, code }
}

beforeAll(async () => {
  daemon = Bun.spawn(['bun', cli, 'daemon'], { env, cwd: home, stdout: 'inherit', stderr: 'inherit' })
  const portFile = join(kHome, 'daemon.port')
  await until(() => existsSync(portFile))
  base = `http://127.0.0.1:${readFileSync(portFile, 'utf8').trim()}`
  owner = new Kurultay({ sk: newSecretKey(), name: 'tolga', kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
  await owner.start()
})

afterAll(async () => {
  daemon?.kill()
  await owner?.stop()
  relay.stop()
})

test('health answers the app with CORS, and refuses foreign hosts and origins', async () => {
  const ok = await http('/health')
  expect(ok.json).toMatchObject({ app: 'kurultay', paired: false, paused: false })
  expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN)
  expect(ok.headers.get('access-control-allow-private-network')).toBe('true')
  const pre = await fetch(base + '/state', { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'GET' } })
  expect(pre.status).toBe(204)
  expect((await http('/health', { host: 'rebind.example' })).status).toBe(403)
  expect((await http('/health', { origin: 'https://evil.example' })).status).toBe(403)
})

test('without a token only health and pairing answer', async () => {
  expect((await http('/state', { token: null })).status).toBe(401)
  expect((await http('/state', { token: 'f'.repeat(64) })).status).toBe(401)
  expect((await http('/seat', { body: { ticket: 'x', hosts: ['codex'], workdir: work }, token: null })).status).toBe(401)
  expect((await http('/pair/request', { method: 'POST', token: null, origin: null })).status).toBe(403)
})

test('pairing: the page shows a code, only a terminal approves it, the page gets its token once', async () => {
  const req = await http('/pair/request', { body: {}, token: null })
  const code = String(req.json.code)
  expect(code).toMatch(/^\d{6}$/)
  expect((await http(`/pair/poll?id=${req.json.id}`, { token: null })).json.status).toBe('pending')

  const listed = await kurultay('pair')
  expect(listed.out).toContain(ORIGIN)
  expect(listed.out).not.toContain(code)
  const wrong = await kurultay('pair', code === '000000' ? '111111' : '000000')
  expect(wrong.code).toBe(1)
  expect((await kurultay('pair', '12ab')).code).toBe(1)

  const right = await kurultay('pair', code)
  expect(right.code).toBe(0)
  expect(right.out).toContain(ORIGIN)
  const poll = await http(`/pair/poll?id=${req.json.id}`, { token: null })
  expect(poll.json.status).toBe('approved')
  token = String(poll.json.token)
  expect((await http(`/pair/poll?id=${req.json.id}`, { token: null })).json.status).toBe('expired')

  const snap = await state()
  expect(snap.agents).toEqual([])
  expect(snap.hosts.find((h) => h.id === 'codex')).toEqual({ id: 'codex', label: 'Codex', detected: true, seated: false })
  expect(readFileSync(join(kHome, 'pairings.json'), 'utf8')).not.toContain(token)
  expect((await http('/health')).json.paired).toBe(true)
})

test('folders can be browsed, without dotfiles', async () => {
  const r = await http(`/fs/list?path=${encodeURIComponent(home)}`)
  expect(r.json).toMatchObject({ path: home })
  expect(r.json.dirs).toContain('project')
  expect(r.json.dirs).not.toContain('.codex')
  expect((await http('/fs/list?path=/definitely/not/here')).status).toBe(400)
})

test('the app seats, moves, stops, starts and removes an agent', async () => {
  const g = owner.createGroup('ops')
  const ticket = owner.createTicket([g.id], { hosts: ['codex'] })
  expect((await http('/seat', { body: { ticket, hosts: ['codex'], workdir: '/definitely/not/here' } })).status).toBe(400)
  expect((await http('/seat', { body: { ticket, hosts: [], workdir: work } })).json.code).toBe('no-hosts')
  expect((await http('/seat', { body: { ticket: 'kurultay:nonsense', hosts: ['codex'], workdir: work } })).json.code).toBe('bad-ticket')

  const seated = await http('/seat', { body: { ticket, hosts: ['codex'], workdir: work } })
  expect(seated.status).toBe(200)
  expect(seated.json.agents).toEqual([expect.objectContaining({ instance: 'codex#1', host: 'codex' })])
  expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain('[mcp_servers.kurultay]')
  await until(() => owner.members(g.id).some((m) => m.kind === 'agent'))
  const agentPk = owner.members(g.id).find((m) => m.kind === 'agent')?.pubkey
  await until(async () => (await state()).agents[0]?.councils.includes('ops'))
  expect((await state()).agents[0]).toMatchObject({ instance: 'codex#1', pubkey: agentPk, workdir: work, mode: 'talk' })
  expect((await state()).hosts.find((h) => h.id === 'codex')?.seated).toBe(true)

  const other = join(home, 'other')
  mkdirSync(other)
  expect((await http('/agents/workdir', { body: { instance: 'codex#1', workdir: other } })).status).toBe(200)
  expect((await state()).agents[0].workdir).toBe(other)
  expect((await http('/agents/workdir', { body: { instance: 'codex#1', workdir: '/nope/nope' } })).status).toBe(400)
  expect((await http('/agents/workdir', { body: { instance: 'gemini#1', workdir: other } })).json.code).toBe('unknown-agent')

  // the sandbox: the machine says whether it can run one; agents seated by the app may be kept in one (docs/sandbox.md)
  expect((await state()).sandbox).toHaveProperty('ok')
  expect((await state()).agents[0].sandbox).toBeUndefined()
  const refusedGrants = await http('/agents/sandbox', { body: { instance: 'codex#1', sandbox: { enabled: 'yes', allowDomains: ['localhost', 'Docs.Example.com'], readPaths: ['~/.ssh', kHome], writePaths: 'nope' } } })
  expect(refusedGrants.status).toBe(400)
  expect(refusedGrants.json.code).toBe('not-allowed')
  // every bad field at once, so the app can mark them all
  for (const bad of ['enabled', 'allowDomains localhost', 'readPaths ~/.ssh', `readPaths ${kHome}`, 'writePaths']) expect(String(refusedGrants.json.error)).toContain(bad)
  expect((await http('/agents/sandbox', { body: { instance: 'gemini#1', sandbox: { enabled: true, allowDomains: [], readPaths: [], writePaths: [] } } })).json.code).toBe('unknown-agent')
  const grants = { enabled: true, allowDomains: ['Docs.Example.com'], readPaths: ['~/project'], writePaths: [] }
  expect((await http('/agents/sandbox', { body: { instance: 'codex#1', sandbox: grants } })).status).toBe(200)
  expect((await state()).agents[0].sandbox).toEqual({ enabled: true, allowDomains: ['docs.example.com'], readPaths: [work], writePaths: [], lastViolations: [] })
  // seating again without the box keeps what was granted and only switches the sandbox off; with it, back on
  const reseat = await http('/seat', { body: { ticket, hosts: ['codex'], workdir: work, sandbox: false } })
  expect(reseat.json.agents).toEqual([expect.objectContaining({ instance: 'codex#1', pubkey: agentPk })])
  expect(JSON.parse(readFileSync(join(kHome, 'agents.json'), 'utf8'))['codex#1'].sandbox).toEqual({ enabled: false, allowDomains: ['docs.example.com'], readPaths: [work], writePaths: [] })
  await http('/seat', { body: { ticket, hosts: ['codex'], workdir: work, sandbox: true } })
  expect(JSON.parse(readFileSync(join(kHome, 'agents.json'), 'utf8'))['codex#1'].sandbox.enabled).toBe(true)
  await until(async () => (await state()).agents[0]?.online)

  expect((await http('/daemon/pause', { body: {} })).status).toBe(200)
  const paused = await state()
  expect(paused.paused).toBe(true)
  expect(paused.agents[0]).toMatchObject({ instance: 'codex#1', online: false })
  const refused = await http('/seat', { body: { ticket, hosts: ['codex'], workdir: work } })
  expect(refused.status).toBe(409)
  expect(refused.json.code).toBe('paused')
  await http('/daemon/resume', { body: {} })
  await until(async () => (await state()).agents[0]?.online)

  expect((await http('/agents/remove', { body: { instance: 'codex#1' } })).status).toBe(200)
  expect((await state()).agents).toEqual([])
  // it said goodbye on its way out, so the council no longer lists it
  await until(() => !owner.members(g.id).some((m) => m.kind === 'agent'))
  expect(existsSync(join(kHome, 'instances/codex#1'))).toBe(false)
  expect((await http('/agents/remove', { body: { instance: 'codex#1' } })).status).toBe(400)
})

test('kurultay pair --revoke signs every browser out', async () => {
  expect((await kurultay('pair', '--revoke')).code).toBe(0)
  expect((await http('/state')).status).toBe(401)
  expect((await http('/health')).json.paired).toBe(false)
})
