import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kurultay, MemoryStorage, newSecretKey, PLAYFUL_NAMES } from '@kurultay/core'
import { startTestBlossom, startTestRelay } from '@kurultay/core/testing'

const relay = startTestRelay(0)
const blossom = startTestBlossom(0)
// realpath: on macOS tmpdir() is under /var, a symlink to /private/var, and the CLI reports its resolved process.cwd()
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kurultay-daemon-')))
const bin = join(home, 'bin')
const work = join(home, 'project')
mkdirSync(bin)
mkdirSync(work)
// a stand-in for the real Codex CLI: answers with what it was given, so the test can check context + permissions
writeFileSync(
  join(bin, 'codex'),
  `#!/usr/bin/env node
const a = process.argv.slice(2)
const out = a[a.indexOf('-o') + 1]
const sandbox = a[a.indexOf('--sandbox') + 1]
const prompt = a[a.length - 1]
const sawContext = prompt.includes('the deploy script lives in ops/deploy.sh')
const fs = require('fs')
const saved = prompt.match(/saved at (\\S+)/)
const file = saved ? ' file=' + fs.readFileSync(saved[1], 'utf8').trim() : ''
let attach = ''
if (prompt.includes('please attach')) {
  fs.writeFileSync('report.txt', 'all green')
  attach = '\\n[[attach: report.txt]]\\n[[attach: /etc/passwd]]'
}
fs.writeFileSync(out, 'sandbox=' + sandbox + ' context=' + sawContext + ' cwd=' + process.cwd() + file + attach)
`,
)
chmodSync(join(bin, 'codex'), 0o755)

const env = { ...process.env, HOME: home, KURULTAY_HOME: join(home, '.config/kurultay'), KURULTAY_NO_KEYCHAIN: '1', KURULTAY_RELAYS: relay.url, KURULTAY_BLOSSOM: blossom.url, KURULTAY_MACHINE: 'testbox', PATH: `${bin}:${process.env.PATH}` }
let daemon: ReturnType<typeof Bun.spawn> | undefined
let owner: Kurultay
afterAll(async () => {
  daemon?.kill()
  await owner?.stop()
  relay.stop()
  blossom.stop()
})

const until = async (cond: () => unknown, ms = 10000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await Bun.sleep(100)
  }
}

test('background agent answers when tagged, with council context, inside the owner’s permissions', async () => {
  owner = new Kurultay({ sk: newSecretKey(), name: 'tolga', kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000, blossom: [blossom.url] })
  await owner.start()
  const g = owner.createGroup('ops')
  const ticket = owner.createTicket([g.id], { hosts: ['codex'] })

  // join without a service (tests), then register + start the daemon the way the service would
  const j = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), 'join', ticket, '--no-background'], { env, cwd: work, stdout: 'pipe', stderr: 'pipe' })
  await j.exited
  const out = await new Response(j.stdout).text()
  expect(out).toContain(`Working folder: ${work}`)
  const handle = JSON.parse(readFileSync(join(home, '.config/kurultay/instances/codex#1/state.json'), 'utf8')).agentSettings.name
  expect((PLAYFUL_NAMES as readonly string[]).includes(handle)).toBe(true)
  expect(out).toContain(`${handle} joined #ops`)
  writeFileSync(join(home, '.config/kurultay/agents.json'), JSON.stringify({ 'codex#1': { host: 'codex', workdir: work, addedAt: Date.now() } }))
  daemon = Bun.spawn(['bun', join(import.meta.dir, '../src/cli.ts'), 'daemon'], { env, cwd: home, stdout: 'inherit', stderr: 'inherit' })

  // the owner's app learns where the agent works (privately, via its inbox)
  const agent = owner.members(g.id).find((m) => m.kind === 'agent')!
  const agentPk = agent.pubkey
  // the playful handle is what the council sees, and what @mentions route on below
  expect(agent.name).toBe(handle)
  await until(() => owner.state.agentStatus?.[agentPk]?.background)
  expect(owner.state.agentStatus![agentPk].workdir).toBe(work)
  expect(owner.state.agentStatus![agentPk].mode).toBe('talk')

  // conversation the agent was not tagged in still gives it context
  await owner.send(g.id, 'the deploy script lives in ops/deploy.sh')
  await Bun.sleep(500)
  // tagged → background turn → reply in the council, with context, read-only sandbox for "talk"
  await owner.send(g.id, `@${handle} where is the deploy script?`)
  await until(() => owner.state.groups[g.id].history.some((m) => m.from === agentPk && m.text.includes('sandbox=')), 15000)
  let reply = owner.state.groups[g.id].history.findLast((m) => m.from === agentPk)!
  expect(reply.text).toContain('@tolga')
  expect(reply.text).toContain('sandbox=read-only')
  expect(reply.text).toContain('context=true')
  expect(reply.text).toContain(`cwd=${work}`)
  // the owner's app sees the turn finish
  await until(() => owner.state.agentStatus?.[agentPk]?.running === false && owner.state.agentStatus?.[agentPk]?.lastRun, 5000)

  // owner raises the permission in the app → next turn runs with a writable sandbox
  await owner.setAgentMode(agentPk, 'edit')
  await until(() => owner.state.agentStatus?.[agentPk]?.mode === 'edit')
  await owner.send(g.id, `@${handle} fix it please`)
  await until(() => owner.state.groups[g.id].history.some((m) => m.from === agentPk && m.text.includes('workspace-write')), 15000)

  // files in: saved into the folder for the CLI to read
  const ref = await owner.uploadFile(new TextEncoder().encode('budget is 42k'), 'budget.txt', 'text/plain')
  await owner.send(g.id, `@${handle} what does the attached say?`, { files: [ref] })
  await until(() => owner.state.groups[g.id].history.some((m) => m.from === agentPk && m.text.includes('file=budget is 42k')), 15000)
  // files out: [[attach: …]] inside the folder is shared, anything outside is refused
  await owner.send(g.id, `@${handle} please attach the report`)
  await until(() => owner.state.groups[g.id].history.some((m) => m.from === agentPk && m.files?.length), 15000)
  const withFile = owner.state.groups[g.id].history.findLast((m) => m.from === agentPk && m.files?.length)!
  expect(withFile.files!.map((f) => f.name)).toEqual(['report.txt'])
  expect(new TextDecoder().decode(await owner.downloadFile(withFile.files![0]))).toBe('all green')
  expect(withFile.text).toContain('outside the working folder')
  expect(withFile.text).not.toContain('[[attach')

  // an open CLI session uses the same agent through the daemon (no second identity)
  const { createServer } = await import('../src/server')
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  Object.assign(process.env, { HOME: home, KURULTAY_HOME: env.KURULTAY_HOME })
  const app = createServer({ host: 'codex' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await app.connect(a)
  const c = new Client({ name: 'codex-mcp-client', version: '1' })
  await c.connect(b)
  const st = JSON.parse(((await c.callTool({ name: 'status', arguments: {} })) as any).content[0].text)
  expect(st.you.pubkey).toBe(agentPk)
  expect(st.you.working_folder).toBe(work)
  expect(st.you.background).toBe(true)
  await app.shutdown()

  // "off": the agent stays seated but doesn't answer on its own
  await owner.setAgentMode(agentPk, 'off')
  await until(() => owner.state.agentStatus?.[agentPk]?.mode === 'off')
  const before = owner.state.groups[g.id].history.length
  await owner.send(g.id, `@${handle} are you there?`)
  await Bun.sleep(4000)
  reply = owner.state.groups[g.id].history.findLast((m) => m.from === agentPk)!
  expect(owner.state.groups[g.id].history.length).toBe(before + 1)
}, 60000)
