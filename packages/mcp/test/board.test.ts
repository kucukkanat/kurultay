import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildElements, Kurultay, MemoryStorage, newSecretKey, visible } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'
import { applyBoardOps, boardForPrompt, freshBoard, takeBoardBlocks } from '../src/board-ops'
import { buildPrompt } from '../src/headless'
import { createServer } from '../src/server'

process.env.KURULTAY_HOME = mkdtempSync(join(tmpdir(), 'kurultay-board-'))
process.env.KURULTAY_NO_KEYCHAIN = '1'
const relay = startTestRelay(0)
const engines: Kurultay[] = []
const apps: ReturnType<typeof createServer>[] = []
afterAll(async () => {
  await Promise.all([...engines.map((e) => e.stop()), ...apps.map((a) => a.shutdown())])
  relay.stop()
})

async function until(cond: () => unknown, ms = 6000) {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await Bun.sleep(25)
  }
}

async function engine(name: string, kind: 'human' | 'agent') {
  const e = new Kurultay({ sk: newSecretKey(), name, kind, relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
  engines.push(e)
  await e.start()
  await until(() => e.pool.relays.every((r) => r.status === 'open'))
  return e
}

async function council() {
  const owner = await engine('owner', 'human')
  const agent = await engine('helper', 'agent')
  const g = owner.createGroup('planning')
  await agent.redeem(owner.createInvite(g.id))
  await until(() => agent.state.groups[g.id] && Object.keys(owner.state.groups[g.id]?.roster.members ?? {}).length === 2)
  return { owner, agent, g }
}

const words = (e: Kurultay, gid: string) => visible(e.boardScene(gid)).flatMap((x) => (typeof x.text === 'string' ? [x.text] : []))

describe('```board blocks in a background answer', () => {
  test('are taken out of the answer and parsed', () => {
    const answer = 'Here is the flow.\n\n```board\n{"draw":[{"kind":"rectangle","x":0,"y":0,"label":"API"}]}\n```\n\nAsk if you want more.'
    expect(takeBoardBlocks(answer)).toEqual({ text: 'Here is the flow.\n\nAsk if you want more.', ops: [{ draw: [{ kind: 'rectangle', x: 0, y: 0, label: 'API' }] }], errors: [] })
  })

  test('a broken block becomes a plain note, never raw JSON in the council', () => {
    const bad = takeBoardBlocks('ok\n```board\n{not json\n```')
    expect(bad).toEqual({ text: 'ok', ops: [], errors: ['(I couldn’t draw that on the board: the drawing was not valid JSON.)'] })
    const wrong = takeBoardBlocks('```board\n{"draw":[{"kind":"star","x":0,"y":0}]}\n```')
    expect(wrong.ops).toEqual([])
    expect(wrong.errors[0]).toStartWith('(I couldn’t draw that on the board: draw.0.kind')
    expect(takeBoardBlocks('```board\n{"draw":[{"kind":"text","x":0,"y":0,"text":"x","strokeColor":"url(evil)"}]}\n```').ops).toEqual([])
  })

  test('other fenced blocks are left alone', () => {
    const answer = '```mermaid\ngraph LR\n```'
    expect(takeBoardBlocks(answer)).toEqual({ text: answer, ops: [], errors: [] })
  })

  test('are drawn for the council, and the reply says what happened', async () => {
    const { owner, agent, g } = await council()
    const { ops } = takeBoardBlocks('```board\n{"draw":[{"kind":"rectangle","x":0,"y":0,"label":"Client"},{"kind":"rectangle","x":300,"y":0,"label":"Relay"},{"kind":"arrow","from":"#0","to":"#1","label":"wraps"}]}\n```')
    expect(await applyBoardOps(agent, g.id, ops)).toBe('_(On the board: drew 3, edited 0, removed 0.)_')
    await until(() => words(owner, g.id).includes('wraps'))

    // the next background turn's prompt lists the board, ids included, so the agent can edit what is there
    const listing = boardForPrompt(agent, g.id)
    const relayId = /^(\w+) rectangle .*"Relay"$/m.exec(listing)?.[1] ?? ''
    expect(relayId).not.toBe('')
    const prompt = buildPrompt(agent, [{ groupId: g.id, id: 'm1', from: owner.pubkey, type: 'chat', text: '@helper rename relay' }], 'talk', '/tmp')
    expect(prompt).toContain('```board')
    expect(prompt).toContain(`Board: 3 elements on the board:`)
    expect(prompt).toContain(`${relayId} rectangle`)

    const edit = takeBoardBlocks(`\`\`\`board\n{"edit":[{"ids":["${relayId}"],"text":"Relay (forgets everything)"}],"delete":[]}\n\`\`\``)
    expect(await applyBoardOps(agent, g.id, edit.ops)).toBe('_(On the board: drew 0, edited 1, removed 0.)_')
    await until(() => words(owner, g.id).includes('Relay (forgets everything)'))

    const del = takeBoardBlocks(`\`\`\`board\n{"delete":["${relayId}"]}\n\`\`\``)
    expect(await applyBoardOps(agent, g.id, del.ops)).toBe('_(On the board: drew 0, edited 0, removed 1.)_')
    await until(() => !words(owner, g.id).includes('Relay (forgets everything)'))

    const missing = takeBoardBlocks('```board\n{"edit":[{"ids":["nope"],"x":5}]}\n```')
    expect(await applyBoardOps(agent, g.id, missing.ops)).toBe('(Board: no element nope on the board.)')
  })

  test('the prompt caps a large board', async () => {
    const { agent, g } = await council()
    await applyBoardOps(agent, g.id, [{ draw: Array.from({ length: 30 }, (_, i) => ({ kind: 'text' as const, x: 0, y: i * 30, text: `line ${i}` })) }])
    const lines = boardForPrompt(agent, g.id, 10).split('\n')
    expect(lines).toHaveLength(12)
    expect(lines.at(-1)).toBe('… and 20 more')
  })

  test('an agent with no board asks the council once, and gets it', async () => {
    const { owner, agent, g } = await council()
    await owner.drawBoard(g.id, buildElements([{ kind: 'text', x: 0, y: 0, text: 'drawn before' }]))
    await until(() => words(agent, g.id).includes('drawn before'))
    // as if it had been offline while the owner drew
    const forget = () => {
      const group = agent.state.groups[g.id]
      if (group) group.board = {}
    }
    forget()
    expect(visible(await freshBoard(agent, g.id)).map((el) => el.text)).toEqual(['drawn before'])
    // once asked it stays subscribed and gets every change live: an empty board is not asked for again
    forget()
    const start = Date.now()
    expect(await freshBoard(agent, g.id)).toEqual({})
    expect(Date.now() - start).toBeLessThan(200)
  })
})

describe('board tools over MCP', () => {
  async function agent(name: string) {
    const app = createServer({ relays: [relay.url], noDaemon: true })
    apps.push(app)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await app.connect(a)
    const client = new Client({ name, version: '1.0.0' })
    await client.connect(b)
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      const text = r.content[0]?.text ?? ''
      if (r.isError) throw new Error(text)
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    return { client, call, app }
  }

  test('an agent draws, edits and deletes; a second agent sees each change, and fetches the board when it starts empty', async () => {
    const alpha = await agent('alpha')
    const beta = await agent('beta')
    expect((await alpha.client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['board_read', 'board_draw', 'board_edit', 'board_delete']))
    await alpha.call('create_group', { name: 'whiteboard' })
    const { invite } = await alpha.call('invite', { group: 'whiteboard' })
    await Bun.sleep(300)

    const read = await alpha.call('board_read', { group: 'whiteboard' })
    expect(read.board).toBe('The board is empty.')
    expect(read.note).toContain('untrusted')
    const { drawn } = await alpha.call('board_draw', {
      group: 'whiteboard',
      items: [
        { kind: 'diamond', x: 0, y: 0, label: 'Decide' },
        { kind: 'text', x: 0, y: 200, text: 'notes go here' },
        { kind: 'arrow', from: '#0', to: { x: 0, y: 190 } },
      ],
    })
    expect(drawn.map((d: { kind: string }) => d.kind)).toEqual(['diamond', 'text', 'arrow'])

    // beta joins after the drawing: its first read asks the council and alpha answers with the whole board
    await beta.call('join', { invite })
    await until(async () => (await beta.call('groups')).length && (await alpha.call('members', { group: 'whiteboard' })).length === 2)
    await until(async () => /"Decide"/.test((await beta.call('board_read', { group: 'whiteboard' })).board), 10_000)

    const diamond: string = drawn[0].id
    await beta.call('board_edit', { group: 'whiteboard', ids: [diamond], text: 'Decided', backgroundColor: '#ffec99' })
    await until(async () => /"Decided"/.test((await alpha.call('board_read', { group: 'whiteboard' })).board))
    await expect(alpha.call('board_draw', { group: 'whiteboard', items: [{ kind: 'arrow', from: 'ghost', to: '#0' }] })).rejects.toThrow(/cannot find ghost/)
    await expect(alpha.call('board_draw', { group: 'whiteboard', items: [{ kind: 'text', x: 0, y: 0, text: 'x', strokeColor: 'red; evil' }] })).rejects.toThrow()

    await alpha.call('board_delete', { group: 'whiteboard', ids: [diamond] })
    await until(async () => !/"Decided"/.test((await beta.call('board_read', { group: 'whiteboard' })).board))
    await expect(beta.call('board_delete', { group: 'whiteboard', ids: [diamond] })).rejects.toThrow(/no element/)
  }, 30_000)
})
