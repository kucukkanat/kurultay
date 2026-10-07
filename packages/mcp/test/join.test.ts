import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeTicket, Kurultay, MemoryStorage, newSecretKey, PLAYFUL_NAMES } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'
import { runJoin } from '../src/join'

const relay = startTestRelay(0)
let owner: Kurultay
const isPlayful = (n: unknown) => (PLAYFUL_NAMES as readonly unknown[]).includes(n)
const quiet = async (args: string[]) => {
  const logs: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => void logs.push(a.join(' '))
  try {
    return { code: await runJoin(args), out: logs.join('\n') }
  } finally {
    console.log = orig
  }
}
const seatedName = (home: string, host: string): unknown =>
  JSON.parse(readFileSync(join(home, `.config/kurultay/instances/${host}#1/state.json`), 'utf8')).agentSettings?.name
afterAll(async () => {
  await owner?.stop()
  relay.stop()
})

test('kurultay join: one command configures hosts and seats the agents', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kurultay-join-'))
  process.env.HOME = home
  process.env.KURULTAY_HOME = join(home, '.config/kurultay')
  process.env.KURULTAY_NO_KEYCHAIN = '1'
  process.env.KURULTAY_RELAYS = relay.url
  process.env.KURULTAY_MACHINE = 'testbox'

  owner = new Kurultay({ sk: newSecretKey(), name: 'tolga', kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
  await owner.start()
  const g = owner.createGroup('release-council')
  const ticket = owner.createTicket([g.id])

  const { code, out } = await quiet([ticket, '--host', 'codex', '--host', 'opencode'])

  expect(code).toBe(0)
  // agents seated without a name get distinct playful handles from their first message
  const [codexName, opencodeName] = [seatedName(home, 'codex'), seatedName(home, 'opencode')]
  expect(isPlayful(codexName)).toBe(true)
  expect(isPlayful(opencodeName)).toBe(true)
  expect(codexName).not.toBe(opencodeName)
  expect(out).toContain(`✓ ${codexName} joined #release-council`)
  expect(out).toContain(`✓ ${opencodeName} joined #release-council`)
  const members = owner.members(g.id)
  expect(members.filter((m) => m.kind === 'agent' && m.verified?.owner === owner.pubkey)).toHaveLength(2)
  expect(Object.keys(owner.state.approvals)).toHaveLength(0)
  // host configs + skill written, identity persisted for the MCP server to pick up
  expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain('"--host", "codex"')
  expect(existsSync(join(home, '.codex/skills/kurultay/SKILL.md'))).toBe(true)
  const st = JSON.parse(readFileSync(join(home, '.config/kurultay/instances/codex#1/state.json'), 'utf8'))
  expect(st.groups[g.id]).toBeDefined()
  expect(st.owner.attestation).toBeDefined()

  // reseating with the same ticket never renames
  expect((await quiet([ticket, '--host', 'codex', '--host', 'opencode', '--no-background'])).code).toBe(0)
  expect([seatedName(home, 'codex'), seatedName(home, 'opencode')]).toEqual([codexName, opencodeName])
}, 40000)

test('an agent seated before playful names keeps its host@machine name', async () => {
  const home = mkdtempSync(join(tmpdir(), 'kurultay-legacy-'))
  process.env.HOME = home
  process.env.KURULTAY_HOME = join(home, '.config/kurultay')
  const g = owner.createGroup('legacy-council')
  const ticket = owner.createTicket([g.id])
  // same identity (inbox) as the ticket derives, but no agentSettings.name: what older versions wrote
  const { state } = Kurultay.fromTicket(decodeTicket(ticket), 'codex', null)
  const dir = join(home, '.config/kurultay/instances/codex#1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...state, groups: {}, pendingJoins: {} }))
  const { code, out } = await quiet([ticket, '--host', 'codex', '--no-background'])
  expect(code).toBe(0)
  expect(seatedName(home, 'codex')).toBeUndefined()
  expect(out).toContain('✓ codex@testbox joined #legacy-council')
}, 40000)

test('a running session switches to the ticket identity, and the ticket host choice is honoured', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const { createServer } = await import('../src/server')
  const home = mkdtempSync(join(tmpdir(), 'kurultay-live-'))
  process.env.HOME = home
  process.env.KURULTAY_HOME = join(home, '.config/kurultay')
  // session already running for pi, with its own (pre-ticket) identity
  const app = createServer({ relays: [relay.url], host: 'pi', noDaemon: true })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await app.connect(a)
  const client = new Client({ name: 'pi', version: '1' })
  await client.connect(b)
  const status = async () => JSON.parse(((await client.callTool({ name: 'status', arguments: {} })) as any).content[0].text)
  const before = await status()

  const g = owner.createGroup('live-council')
  const ticket = owner.createTicket([g.id], { hosts: ['pi'] })
  const { out } = await quiet([ticket])
  const piName = seatedName(home, 'pi')
  expect(isPlayful(piName)).toBe(true)
  expect(out).toContain(`✓ ${piName} joined #live-council`)
  expect(out).not.toContain('Codex')
  await Bun.sleep(400) // let the old engine try to save and notice the new owner of the file
  const after = await status()
  expect(after.you.pubkey).not.toBe(before.you.pubkey)
  expect(after.groups.map((x: any) => x.name)).toContain('live-council')
  await app.shutdown()
}, 40000)
