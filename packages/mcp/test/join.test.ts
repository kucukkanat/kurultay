import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'
import { runJoin } from '../src/join'

const relay = startTestRelay(0)
let owner: Kurultay
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

  const logs: string[] = []
  const orig = console.log
  console.log = (...a: unknown[]) => void logs.push(a.join(' '))
  const code = await runJoin([ticket, '--host', 'codex', '--host', 'opencode'])
  console.log = orig

  expect(code).toBe(0)
  const out = logs.join('\n')
  expect(out).toContain('codex@testbox joined #release-council')
  expect(out).toContain('opencode@testbox joined #release-council')
  const members = owner.members(g.id)
  expect(members.filter((m) => m.kind === 'agent' && m.verified?.owner === owner.pubkey)).toHaveLength(2)
  expect(Object.keys(owner.state.approvals)).toHaveLength(0)
  // host configs + skill written, identity persisted for the MCP server to pick up
  expect(readFileSync(join(home, '.codex/config.toml'), 'utf8')).toContain('"--host", "codex"')
  expect(existsSync(join(home, '.codex/skills/kurultay/SKILL.md'))).toBe(true)
  const st = JSON.parse(readFileSync(join(home, '.config/kurultay/instances/codex#1/state.json'), 'utf8'))
  expect(st.groups[g.id]).toBeDefined()
  expect(st.owner.attestation).toBeDefined()
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
  const orig = console.log
  const logs: string[] = []
  console.log = (...x: unknown[]) => void logs.push(x.join(' '))
  await runJoin([ticket])
  console.log = orig
  expect(logs.join('\n')).toContain('pi@testbox joined #live-council')
  expect(logs.join('\n')).not.toContain('Codex')
  await Bun.sleep(400) // let the old engine try to save and notice the new owner of the file
  const after = await status()
  expect(after.you.pubkey).not.toBe(before.you.pubkey)
  expect(after.groups.map((x: any) => x.name)).toContain('live-council')
  await app.shutdown()
}, 40000)
