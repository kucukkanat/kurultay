import { describe, expect, test } from 'bun:test'
import { newer } from '@kurultay/core'
import { applyRemote, CURSOR_TTL_MS, cursorColor, liveCursors, markKnown, takeUnsent, throttle, type Cursor } from './sync'

const el = (id: string, version = 1, versionNonce = 5, x = 0) => ({ id, version, versionNonce, x })

describe('board sync', () => {
  test('only what changed locally is sent, once', () => {
    const sent = new Map<string, number>()
    expect(takeUnsent(sent, [el('a'), el('b')]).map((e) => e.id)).toEqual(['a', 'b'])
    expect(takeUnsent(sent, [el('a'), el('b')])).toEqual([])
    expect(takeUnsent(sent, [el('a', 2), el('b')]).map((e) => e.id)).toEqual(['a'])
  })

  test('what arrived from the council is not sent back', () => {
    const sent = new Map<string, number>()
    markKnown(sent, [el('r', 3)])
    expect(takeUnsent(sent, [el('r', 3)])).toEqual([])
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

  test('the tie rule matches the engine: lower nonce wins', () => {
    expect(newer(el('a', 2, 1), el('a', 2, 9))).toBe(true)
    expect(newer(el('a', 2, 9), el('a', 2, 1))).toBe(false)
    expect(newer(el('a'), undefined)).toBe(true)
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
