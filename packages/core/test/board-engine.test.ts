import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { BOARD_POINTER_PER_MINUTE, BOARD_SEND_PER_MINUTE, BoardRefusedError, Kurultay, MemoryStorage, buildElements, chunkElements, editElements, newSecretKey, visible, type BoardElement } from '../src'
import { startTestRelay, type TestRelay } from '../src/testing/relay'

// The board over a real (in-process) relay: what members see, what the relay sees, and who is shut out.
let relay: TestRelay
const peers: Kurultay[] = []
beforeAll(() => {
  relay = startTestRelay(0)
})
afterAll(async () => {
  await Promise.all(peers.map((p) => p.stop()))
  relay.stop()
})

async function until(cond: () => unknown, ms = 6000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await Bun.sleep(20)
  }
}

async function peer(name: string, kind: 'human' | 'agent') {
  const p = new Kurultay({ sk: newSecretKey(), name, kind, relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
  peers.push(p)
  await p.start()
  await until(() => p.pool.relays.every((r) => r.status === 'open'))
  return p
}

async function council(...names: [string, 'human' | 'agent'][]) {
  const [first, ...rest] = await Promise.all(names.map(([n, k]) => peer(n, k)))
  if (!first) throw new Error('a council needs someone')
  const g = first.createGroup(`board-${Math.random().toString(36).slice(2, 7)}`)
  for (const p of rest) {
    await p.redeem(first.createInvite(g.id))
    await until(() => p.state.groups[g.id])
  }
  await until(() => rest.every((p) => Object.keys(p.state.groups[g.id]?.roster.members ?? {}).length === names.length))
  return { g, all: [first, ...rest] }
}

const texts = (p: Kurultay, groupId: string): string[] => visible(p.boardScene(groupId)).flatMap((e) => (typeof e.text === 'string' ? [e.text] : []))

describe('the council board', () => {
  test('a drawing reaches every member, and the relay sees none of it', async () => {
    const { g, all: [alice, bob] } = await council(['alice', 'human'], ['bob', 'human'])
    if (!alice || !bob) throw new Error('setup')
    const seen: BoardElement[][] = []
    bob.on('board', (e) => e.groupId === g.id && seen.push(e.elements))
    const drawn = buildElements([{ kind: 'rectangle', x: 0, y: 0, label: 'quarterly-roadmap-secret' }])
    const changed = await alice.drawBoard(g.id, drawn)
    expect(changed).toHaveLength(2)
    await until(() => texts(bob, g.id).includes('quarterly-roadmap-secret'))
    expect(seen.flat().map((e) => e.id).sort()).toEqual(drawn.map((e) => e.id).sort())
    // the relay forwards ephemeral, wrapped events only: no element text, no author, nothing stored
    expect(relay.stored).toHaveLength(0)
    const wire = JSON.stringify(relay.observed)
    expect(wire).not.toContain('quarterly-roadmap-secret')
    expect(wire).not.toContain(drawn[0]?.id ?? 'x')
    expect(relay.observed.some((e) => e.pubkey === alice.pubkey)).toBe(false)
  })

  test('concurrent edits to one shape settle the same on both sides', async () => {
    const { g, all: [a, b] } = await council(['ann', 'human'], ['ben', 'human'])
    if (!a || !b) throw new Error('setup')
    const [shape] = buildElements([{ kind: 'rectangle', x: 0, y: 0 }])
    if (!shape) throw new Error('setup')
    await a.drawBoard(g.id, [shape])
    await until(() => b.boardScene(g.id)[shape.id])
    // both move it at once: the same version from each side, so the nonce decides, the same way everywhere
    await Promise.all([a.drawBoard(g.id, editElements(a.boardScene(g.id), [shape.id], { x: 111 })), b.drawBoard(g.id, editElements(b.boardScene(g.id), [shape.id], { x: 222 }))])
    await until(() => a.boardScene(g.id)[shape.id]?.x === b.boardScene(g.id)[shape.id]?.x)
    expect([111, 222]).toContain(a.boardScene(g.id)[shape.id]?.x ?? 0)
  })

  test('someone who opens the board later asks for it and gets all of it, once', async () => {
    const { g, all: [admin, early, late] } = await council(['host', 'human'], ['early', 'human'], ['late', 'human'])
    if (!admin || !early || !late) throw new Error('setup')
    const els = buildElements(Array.from({ length: 120 }, (_, i) => ({ kind: 'rectangle' as const, x: i * 10, y: 0, label: `card ${i} ${'x'.repeat(200)}` })))
    await admin.drawBoard(g.id, els)
    await until(() => Object.keys(early.boardScene(g.id)).length === els.length)
    if (late.state.groups[g.id]) late.state.groups[g.id].board = {}
    // count the whole-board envelopes each member sends: one answer is needed, the random wait should keep it to one
    const sent = new Map<string, number>()
    for (const p of [admin, early]) p.on('raw', (r) => r.dir === 'out' && r.env?.type === 'board' && 'full' in r.env && r.env.full && sent.set(p.name, (sent.get(p.name) ?? 0) + 1))
    await late.requestBoard(g.id)
    await until(() => Object.keys(late.boardScene(g.id)).length === els.length, 10_000)
    await Bun.sleep(2200)
    const chunks = chunkElements(Object.values(admin.boardScene(g.id))).length
    expect(chunks).toBeGreaterThan(1)
    expect([...sent.values()]).toEqual([chunks])
  })

  test('a removed member is cut off from new drawings', async () => {
    const { g, all: [admin, stays, goes] } = await council(['lead', 'human'], ['stays', 'human'], ['goes', 'agent'])
    if (!admin || !stays || !goes) throw new Error('setup')
    await admin.removeMember(g.id, goes.pubkey)
    await until(() => !goes.state.groups[g.id])
    await until(() => stays.state.groups[g.id]?.epoch === 1)
    // after a rotation the first events can race the new subscription: draw until the member who stays has it
    for (let i = 0; !texts(stays, g.id).some((t) => t.startsWith('after-removal')); i++) {
      if (i > 15) throw new Error('never delivered')
      await admin.drawBoard(g.id, buildElements([{ kind: 'text', x: 0, y: i * 30, text: `after-removal ${i}` }]))
      await Bun.sleep(400)
    }
    expect(goes.state.groups[g.id]).toBeUndefined()
    expect(JSON.stringify(goes.state)).not.toContain('after-removal')
  })

  test('a muted member cannot draw, and their drawings are ignored if their client tries', async () => {
    const { g, all: [admin, loud] } = await council(['mod', 'human'], ['loud', 'human'])
    if (!admin || !loud) throw new Error('setup')
    await admin.moderate(g.id, 'mute', loud.pubkey)
    await until(() => loud.state.groups[g.id]?.roster.muted.includes(loud.pubkey))
    await expect(loud.drawBoard(g.id, buildElements([{ kind: 'text', x: 0, y: 0, text: 'not allowed' }]))).rejects.toThrow(/muted/)
    // a client that ignores its own mute still gets nowhere: the others drop it
    if (loud.state.groups[g.id]) loud.state.groups[g.id].roster.muted = []
    await loud.drawBoard(g.id, buildElements([{ kind: 'text', x: 0, y: 0, text: 'sneaky' }]))
    await Bun.sleep(600)
    expect(texts(admin, g.id)).not.toContain('sneaky')
  })

  test('an agent draws and edits like anyone else, and a paused council stops it', async () => {
    const { g, all: [owner, agent] } = await council(['owner', 'human'], ['helper', 'agent'])
    if (!owner || !agent) throw new Error('setup')
    const drawn = buildElements([
      { kind: 'rectangle', x: 0, y: 0, label: 'Relay' },
      { kind: 'rectangle', x: 300, y: 0, label: 'Council' },
      { kind: 'arrow', from: '#0', to: '#1', label: 'forwards' },
    ])
    await agent.drawBoard(g.id, drawn)
    await until(() => texts(owner, g.id).includes('forwards'))
    const relayBox = drawn.find((e) => e.type === 'rectangle')
    if (!relayBox) throw new Error('setup')
    await agent.drawBoard(g.id, editElements(agent.boardScene(g.id), [relayBox.id], { text: 'Relay (ephemeral)' }))
    await until(() => texts(owner, g.id).includes('Relay (ephemeral)'))
    await owner.moderate(g.id, 'pause')
    await until(() => agent.state.groups[g.id]?.roster.paused)
    await expect(agent.drawBoard(g.id, buildElements([{ kind: 'text', x: 0, y: 0, text: 'too late' }]))).rejects.toThrow(/paused/)
  })

  test('pointers are shown to the others and never stored', async () => {
    const { g, all: [a, b] } = await council(['pa', 'human'], ['pb', 'human'])
    if (!a || !b) throw new Error('setup')
    const got: { x: number; y: number }[] = []
    b.on('pointer', (p) => p.groupId === g.id && got.push(p))
    await a.boardPointer(g.id, 10.4, 20.6)
    await until(() => got.length === 1)
    expect(got[0]).toMatchObject({ x: 10, y: 21 })
    expect(JSON.stringify(b.state)).not.toContain('board_ptr')
    expect(b.boardScene(g.id)).toEqual({})
  })

  test('moving the pointer never uses up what drawing needs', async () => {
    const { g, all: [a, b] } = await council(['mover', 'human'], ['watcher', 'human'])
    if (!a || !b) throw new Error('setup')
    let pointers = 0
    b.on('pointer', (p) => p.groupId === g.id && pointers++)
    for (let i = 0; i < BOARD_POINTER_PER_MINUTE + 20; i++) await a.boardPointer(g.id, i, i)
    await a.drawBoard(g.id, buildElements([{ kind: 'text', x: 0, y: 0, text: 'still syncing' }]))
    await until(() => texts(b, g.id).includes('still syncing'))
    // pointers past their own budget are skipped quietly
    await until(() => pointers === BOARD_POINTER_PER_MINUTE)
  })

  test('drawing has a per-minute budget, and answering a newcomer does not come out of it', async () => {
    const { g, all: [a, b] } = await council(['busy', 'human'], ['newcomer', 'human'])
    if (!a || !b) throw new Error('setup')
    for (let i = 0; i < BOARD_SEND_PER_MINUTE; i++) await a.drawBoard(g.id, buildElements([{ kind: 'rectangle', x: i, y: 0 }]))
    await expect(a.drawBoard(g.id, buildElements([{ kind: 'rectangle', x: -1, y: 0 }]))).rejects.toThrow(/Board rate limit/)
    await until(() => Object.keys(b.boardScene(g.id)).length === BOARD_SEND_PER_MINUTE)
    if (b.state.groups[g.id]) b.state.groups[g.id].board = {}
    await b.requestBoard(g.id)
    await until(() => Object.keys(b.boardScene(g.id)).length === BOARD_SEND_PER_MINUTE)
  }, 20_000)

  test('a flood of board requests gets one answer, and the council is not answered again right away', async () => {
    const { g, all: [host, asker, other] } = await council(['holder', 'human'], ['flooder', 'human'], ['second', 'human'])
    if (!host || !asker || !other) throw new Error('setup')
    await host.drawBoard(g.id, buildElements(Array.from({ length: 60 }, (_, i) => ({ kind: 'rectangle' as const, x: i * 10, y: 0, label: `card ${i} ${'x'.repeat(300)}` }))))
    await until(() => Object.keys(other.boardScene(g.id)).length === Object.keys(host.boardScene(g.id)).length)
    let full = 0
    for (const p of [host, other]) p.on('raw', (r) => r.dir === 'out' && r.env?.type === 'board' && 'full' in r.env && r.env.full && full++)
    for (let i = 0; i < 10; i++) await asker.requestBoard(g.id)
    await Bun.sleep(2500)
    const chunks = chunkElements(Object.values(host.boardScene(g.id))).length
    expect(full).toBe(chunks)
    // someone else asks right after: a whole board just went out, so the next one waits
    await other.requestBoard(g.id)
    await Bun.sleep(2500)
    expect(full).toBe(chunks)
  }, 20_000)

  test('a drawing the board refuses is reported, and the rest still reaches everyone', async () => {
    const { g, all: [a, b] } = await council(['artist', 'human'], ['viewer', 'human'])
    if (!a || !b) throw new Error('setup')
    const [ok] = buildElements([{ kind: 'text', x: 0, y: 0, text: 'fits' }])
    if (!ok) throw new Error('setup')
    const huge = { ...ok, id: 'huge', type: 'freedraw', points: Array.from({ length: 3000 }, (_, i) => [i, i]) }
    const err = await a.drawBoard(g.id, [ok, huge]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BoardRefusedError)
    expect(err instanceof BoardRefusedError && err.sent.map((e) => e.id)).toEqual([ok.id])
    await until(() => texts(b, g.id).includes('fits'))
  })
})
