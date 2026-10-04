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
  expect(existsSync(join(home, '.agents/skills/kurultay/SKILL.md'))).toBe(true)
  const st = JSON.parse(readFileSync(join(home, '.config/kurultay/instances/codex#1/state.json'), 'utf8'))
  expect(st.groups[g.id]).toBeDefined()
  expect(st.owner.attestation).toBeDefined()
}, 40000)
