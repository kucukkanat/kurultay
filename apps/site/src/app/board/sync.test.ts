import { afterAll, describe, expect, test } from 'bun:test'
import { BoardRefusedError, buildElements, Kurultay, MemoryStorage, newer, newSecretKey, type BoardElement } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'
import { applyRemote, boardSender, CURSOR_TTL_MS, cursorColor, liveCursors, markKnown, throttle, unsent, type Cursor } from './sync'

const el = (id: string, version = 1, versionNonce = 5, x = 0) => ({ id, version, versionNonce, x, isDeleted: false })

const relay = startTestRelay(0)
const engines: Kurultay[] = []
afterAll(async () => {
  await Promise.all(engines.map((e) => e.stop()))
  relay.stop()
})

/** A real engine on an in-process relay, alone in a council of its own. */
async function drawer() {
  const e = new Kurultay({ sk: newSecretKey(), name: 'me', kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
  engines.push(e)
  await e.start()
  return { e, g: e.createGroup('sketch') }
}
const until = async (cond: () => unknown, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await Bun.sleep(5)
  }
}

describe('board sync', () => {
  test('only what changed locally is unsent', () => {
    const sent = new Map<string, number>()
    expect(unsent(sent, [el('a'), el('b')]).map((e) => e.id)).toEqual(['a', 'b'])
    markKnown(sent, [el('a'), el('b')])
    expect(unsent(sent, [el('a'), el('b')])).toEqual([])
    expect(unsent(sent, [el('a', 2), el('b')]).map((e) => e.id)).toEqual(['a'])
  })

  test('what arrived from the council is not sent back', () => {
    const sent = new Map<string, number>()
    markKnown(sent, [el('r', 3)])
    expect(unsent(sent, [el('r', 3)])).toEqual([])
    markKnown(sent, [el('r', 1)])
    expect(sent.get('r')).toBe(3)
  })

  test('remote elements replace older local ones and land on top when new', () => {
    const local = [el('a', 1), el('b', 4)]
    const next = applyRemote(local, [el('a', 2, 5, 99), el('b', 3), el('c')])
    expect(next?.map((e) => [e.id, e.version])).toEqual([['a', 2], ['b', 4], ['c', 1]])
    expect(local[0]?.version).toBe(1)
  })

  test('nothing new means no re-render', () => {
    expect(applyRemote([el('a', 2)], [el('a', 1), el('a', 2)])).toBeNull()
  })

  test('the tie rule matches the engine: a deletion, then the lower nonce, wins', () => {
    expect(newer({ ...el('a', 2, 9), isDeleted: true }, el('a', 2, 1))).toBe(true)
    expect(newer(el('a', 2, 1), el('a', 2, 9))).toBe(true)
    expect(newer(el('a', 2, 9), el('a', 2, 1))).toBe(false)
    expect(newer(el('a'), undefined)).toBe(true)
  })

  test('a send that fails is tried again, not forgotten', async () => {
    const { e, g } = await drawer()
    const scene = buildElements([{ kind: 'rectangle', x: 0, y: 0 }])
    const errors: unknown[] = []
    const sent = new Map<string, number>()
    const s = boardSender({ sent, scene: () => scene, draw: (els) => e.drawBoard(g.id, els), onError: (err) => errors.push(err), retryMs: 20 })
    // muted: the engine refuses to send, so nothing counts as sent
    g.roster.muted.push(e.pubkey)
    s.flush()
    await until(() => errors.length === 1)
    expect(unsent(sent, scene)).toHaveLength(1)
    g.roster.muted = []
    await until(() => !unsent(sent, scene).length)
    expect(Object.keys(e.boardScene(g.id))).toEqual(scene.map((x) => x.id))
    expect(errors).toHaveLength(1)
  })

  test('an element the board refuses is reported once, and the rest is sent', async () => {
    const { e, g } = await drawer()
    const [ok] = buildElements([{ kind: 'rectangle', x: 0, y: 0 }])
    if (!ok) throw new Error('setup')
    const huge: BoardElement = { ...ok, id: 'huge', type: 'freedraw', points: Array.from({ length: 3000 }, (_, i) => [i, i]) }
    const errors: unknown[] = []
    const sent = new Map<string, number>()
    const s = boardSender({ sent, scene: () => [ok, huge], draw: (els) => e.drawBoard(g.id, els), onError: (err) => errors.push(err), retryMs: 20 })
    s.flush()
    await until(() => errors.length === 1)
    expect(errors[0]).toBeInstanceOf(BoardRefusedError)
    expect(Object.keys(e.boardScene(g.id))).toEqual([ok.id])
    expect(unsent(sent, [ok, huge])).toEqual([])
    s.flush()
    await Bun.sleep(60)
    expect(errors).toHaveLength(1)
  })

  test('edits made while a send is in flight follow it', async () => {
    const { e, g } = await drawer()
    let scene = buildElements([{ kind: 'rectangle', x: 0, y: 0 }])
    const sent = new Map<string, number>()
    const s = boardSender({ sent, scene: () => scene, draw: (els) => e.drawBoard(g.id, els), onError: () => {}, retryMs: 20 })
    s.flush()
    scene = [...scene, ...buildElements([{ kind: 'ellipse', x: 200, y: 0 }])]
    s.flush()
    await until(() => !unsent(sent, scene).length)
    expect(Object.keys(e.boardScene(g.id))).toHaveLength(2)
  })

  test('still pointers fade away', () => {
    const now = 100_000
    const cursors = new Map<string, Cursor>([['fresh', { x: 0, y: 0, name: 'a', at: now - 100 }], ['stale', { x: 0, y: 0, name: 'b', at: now - CURSOR_TTL_MS - 1 }]])
    expect(liveCursors(cursors, now).map(([k]) => k)).toEqual(['fresh'])
  })

  test('a member keeps one colour', () => {
    expect(cursorColor('ab12cd' + '0'.repeat(58))).toEqual(cursorColor('ab12cd' + 'f'.repeat(58)))
    expect(cursorColor('000000')).not.toEqual(cursorColor('00ff00'))
  })

  test('throttle runs at most once per window with the latest arguments, and flushes the last call', async () => {
    const calls: number[] = []
    const t = throttle(40, (n: number) => calls.push(n))
    t(1)
    t(2)
    t(3)
    await Bun.sleep(60)
    expect(calls).toEqual([3])
    t(4)
    await Bun.sleep(60)
    expect(calls).toEqual([3, 4])
    t(5)
    t.cancel()
    await Bun.sleep(60)
    expect(calls).toEqual([3, 4])
  })
})
