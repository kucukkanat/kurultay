// A real daemon, a real relay and a real sandbox: a background turn of a sandboxed agent is told it is sandboxed, cannot
// read its owner's home, cannot pass a hidden file off as its answer, and when the sandbox blocks what it needed the
// council hears only that (D34), never what.
// Skipped, with the reason, where the sandbox cannot run (Linux without bwrap, socat and rg).
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EMPTY_SANDBOX_GRANTS, Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'
import { BLOCKED_NOTE } from '../src/daemon'
import { srtBackend } from '../src/sandbox/srt'

const avail = await srtBackend.available()
if (!avail.ok) console.warn(`skipping the sandboxed daemon test: ${avail.reason}`)

const relay = startTestRelay(0)
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kurultay-dsbx-')))
const bin = join(home, 'bin')
// outside the home folder: a Talk turn may not read its working folder, and Linux hides a denied home entirely
const work = realpathSync(mkdtempSync(join(tmpdir(), 'kurultay-dsbx-work-')))
mkdirSync(bin)
writeFileSync(join(home, 'secret.txt'), 'the owner’s secret')
// a stand-in for Codex: reports what the sandbox let it do; asked to fetch, it goes through the proxy to a host nobody
// allowed and then gives up without an answer, as a real CLI does when its tool call is refused
writeFileSync(
  join(bin, 'codex'),
  `#!/usr/bin/env node
const fs = require('fs')
const net = require('net')
const a = process.argv.slice(2)
const out = a[a.indexOf('-o') + 1]
const prompt = a[a.length - 1]
let secret = 'read'
try { fs.readFileSync(${JSON.stringify(join(home, 'secret.txt'))}) } catch { secret = 'refused' }
// the prompt carries the conversation so far: the newest request is checked first
if (prompt.includes('link it')) fs.symlinkSync(${JSON.stringify(join(home, 'secret.txt'))}, out)
else if (prompt.includes('fetch it')) {
  const proxy = new URL(process.env.HTTP_PROXY)
  const auth = proxy.username ? 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') + '\\r\\n' : ''
  const s = net.connect(Number(proxy.port), proxy.hostname, () => s.write('GET http://blocked.example/ HTTP/1.1\\r\\nHost: blocked.example\\r\\n' + auth + 'Connection: close\\r\\n\\r\\n'))
  s.on('data', () => {})
  s.on('close', () => process.exit(1))
  s.on('error', () => process.exit(1))
} else fs.writeFileSync(out, 'secret=' + secret + ' told=' + prompt.includes('You run in a sandbox'))
`,
)
chmodSync(join(bin, 'codex'), 0o755)
const kHome = join(home, '.config/kurultay')
const env = { ...process.env, HOME: home, KURULTAY_HOME: kHome, KURULTAY_NO_KEYCHAIN: '1', KURULTAY_RELAYS: relay.url, KURULTAY_MACHINE: 'testbox', KURULTAY_PORT: '0', PATH: `${bin}:${process.env.PATH}` }
const cli = join(import.meta.dir, '../src/cli.ts')
let daemon: ReturnType<typeof Bun.spawn> | undefined
let owner: Kurultay | undefined
afterAll(async () => {
  daemon?.kill()
  await owner?.stop()
  relay.stop()
})

const until = async (cond: () => unknown, ms = 15_000) => {
  for (const start = Date.now(); !cond(); await Bun.sleep(100)) if (Date.now() - start > ms) throw new Error('timeout')
}

test.skipIf(!avail.ok)('a sandboxed background turn keeps out of the home folder, and a blocked turn says only that it was blocked', async () => {
  owner = new Kurultay({ sk: newSecretKey(), name: 'tolga', kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
  await owner.start()
  const g = owner.createGroup('ops')
  const j = Bun.spawn(['bun', cli, 'join', owner.createTicket([g.id], { hosts: ['codex'] }), '--no-background'], { env, cwd: work, stdout: 'pipe', stderr: 'pipe' })
  expect(await j.exited).toBe(0)
  // what "Keep in a sandbox" in the app writes
  writeFileSync(join(kHome, 'agents.json'), JSON.stringify({ 'codex#1': { host: 'codex', workdir: work, addedAt: Date.now(), sandbox: { ...EMPTY_SANDBOX_GRANTS, enabled: true } } }))
  const d = Bun.spawn(['bun', cli, 'daemon'], { env, cwd: home, stdout: 'pipe', stderr: 'inherit' })
  daemon = d
  // the service's log, read as it comes: a refused output file shows up there, and never in the council
  let logged = ''
  void (async () => {
    const reader = d.stdout.getReader()
    for (let r = await reader.read(); !r.done; r = await reader.read()) logged += new TextDecoder().decode(r.value)
  })()
  const o = owner
  await until(() => o.members(g.id).some((m) => m.kind === 'agent'))
  const agent = o.members(g.id).find((m) => m.kind === 'agent')
  if (!agent) throw new Error('the agent never took its seat')
  await until(() => o.state.agentStatus?.[agent.pubkey]?.background)
  const replies = () => o.state.groups[g.id]?.history.filter((m) => m.from === agent.pubkey) ?? []

  await o.send(g.id, `@${agent.name} what do you see?`)
  await until(() => replies().some((m) => m.text.includes('secret=')), 30_000)
  expect(replies().at(-1)?.text).toContain('secret=refused told=true')

  await o.send(g.id, `@${agent.name} fetch it`)
  await until(() => replies().some((m) => m.text === BLOCKED_NOTE), 30_000)
  // the council learns nothing about what was blocked; the owner sees it in the app (snapshot.agents[].sandbox)
  expect(replies().some((m) => m.text.includes('blocked.example'))).toBe(false)

  // the agent swaps its output file for a link to the owner's secret, which the service reads outside the sandbox
  await o.send(g.id, `@${agent.name} link it`)
  const leaked = () => o.state.groups[g.id]?.history.some((m) => m.text.includes('the owner’s secret'))
  await until(() => logged.includes('is a link') || leaked(), 30_000)
  expect(leaked()).toBe(false)
}, 90_000)
