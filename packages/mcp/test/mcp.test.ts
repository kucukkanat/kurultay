import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { startTestBlossom, startTestRelay } from '@kurultay/core/testing'
import { createServer } from '../src/server'

process.env.KURULTAY_HOME = mkdtempSync(join(tmpdir(), 'kurultay-'))
process.env.KURULTAY_NO_KEYCHAIN = '1'
const relay = startTestRelay(0)
const blossom = startTestBlossom(0)
process.env.KURULTAY_BLOSSOM = blossom.url
const apps: ReturnType<typeof createServer>[] = []
afterAll(async () => {
  await Promise.all(apps.map((a) => a.shutdown()))
  relay.stop()
  blossom.stop()
})

async function agent(name: string) {
  const app = createServer({ relays: [relay.url], noDaemon: true })
  apps.push(app)
  const [a, b] = InMemoryTransport.createLinkedPair()
  await app.connect(a)
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(b)
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name: tool, arguments: args })
    const text = r.content[0].text as string
    if (r.isError) throw new Error(text)
    try { return JSON.parse(text) } catch { return text }
  }
  return { client, call, app }
}

test('two MCP agents converse through an encrypted group', async () => {
  const alpha = await agent('alpha')
  const beta = await agent('beta')
  const tools = await alpha.client.listTools()
  expect(tools.tools.map((t) => t.name)).toContain('wait')

  const st = await alpha.call('status')
  expect(st.you.name).toMatch(/^alpha@/)
  expect(st.you.key_storage).toBe('file')
  expect(st.you.instructions).toBeUndefined()
  const engine = alpha.app.engine
  if (!engine) throw new Error('engine not started')
  engine.state.agentSettings = { mode: 'talk', instructions: 'Answer in haiku.', updatedAt: 0 }
  expect((await alpha.call('status')).you.instructions).toBe('Answer in haiku.')

  await alpha.call('create_group', { name: 'council' })
  const { invite } = await alpha.call('invite', { group: 'council' })
  expect(invite).toContain('#join=')
  await Bun.sleep(300)
  await beta.call('join', { invite })
  const betaName = (await beta.call('status')).you.name
  const alphaName = st.you.name
  for (let i = 0; i < 50; i++) {
    const g = await beta.call('groups')
    if (g.length) break
    await Bun.sleep(50)
  }
  await alpha.call('send', { group: 'council', text: `@${betaName} what is 2+2?` })
  const got = await beta.call('wait', { timeout_seconds: 5 })
  expect(got.messages[0].text).toContain('2+2')
  expect(got.messages[0].from).toBe(alphaName)
  expect(got.note).toContain('untrusted')

  await beta.call('send', { group: 'council', text: `@${alphaName} it is 4` })
  const back = await alpha.call('wait', { group: 'council', timeout_seconds: 5 })
  expect(back.messages.map((m: any) => m.text)).toContain(`@${alphaName} it is 4`)

  const t = await alpha.call('task', { group: 'council', to: betaName, title: 'Write a haiku' })
  const tk = await beta.call('wait', { timeout_seconds: 5 })
  expect(tk.messages[0].type).toBe('task')
  await beta.call('update_task', { group: 'council', task_id: t.task_id, status: 'done', output: 'ok' })
  const upd = await alpha.call('wait', { timeout_seconds: 5 })
  expect(upd.messages[0].type).toBe('task_update')

  // files: alpha attaches a local file, beta sees it in wait and saves the decrypted copy
  const work = mkdtempSync(join(tmpdir(), 'kurultay-files-'))
  writeFileSync(join(work, 'plan.md'), '# plan\nship friday\n')
  await alpha.call('send', { group: 'council', text: `@${betaName} the plan`, files: [join(work, 'plan.md')] })
  const withFile = await beta.call('wait', { timeout_seconds: 5 })
  const msg = withFile.messages[0]
  expect(msg.files[0]).toMatchObject({ index: 0, name: 'plan.md', type: 'text/markdown' })
  expect(JSON.stringify(msg)).not.toContain('"key"')
  const saved = await beta.call('save_file', { group: 'council', message_id: msg.id, dir: work + '/in' })
  expect(readFileSync(saved.saved[0].path, 'utf8')).toBe('# plan\nship friday\n')
  await expect(alpha.call('send', { group: 'council', text: 'x', files: ['/no/such/file'] })).rejects.toThrow(/No such file/)

  const empty = await beta.call('wait', { timeout_seconds: 0.2 })
  expect(empty.messages).toHaveLength(0)
}, 20000)
