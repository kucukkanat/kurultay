import { describe, expect, test } from 'bun:test'
import {
  MAX_BOARD_ELEMENTS, MAX_CHUNK_BYTES, buildElements, chunkElements, edgePoint, editElements, mergeElements, newer, sanitizeElement, summarize, visible,
  type BoardElement,
} from '../src/board'

const el = (over: Partial<BoardElement> = {}): BoardElement => ({
  id: 'a1', type: 'rectangle', version: 1, versionNonce: 10, isDeleted: false, updated: 1, x: 0, y: 0, width: 100, height: 50, ...over,
})
const scene = (...els: BoardElement[]): Record<string, BoardElement> => Object.fromEntries(els.map((e) => [e.id, e]))

describe('sanitizeElement', () => {
  test('keeps a drawing element and everything Excalidraw put on it', () => {
    const out = sanitizeElement({ ...el(), strokeColor: '#1e1e1e', roughness: 1, groupIds: ['g'] })
    expect(out?.strokeColor).toBe('#1e1e1e')
    expect(out?.groupIds).toEqual(['g'])
  })

  test('refuses what would pull content from outside the council', () => {
    for (const type of ['image', 'embeddable', 'iframe', 'magicframe']) expect(sanitizeElement(el({ type: type as BoardElement['type'] }))).toBeNull()
  })

  test('a link survives only as a plain web address', () => {
    expect(sanitizeElement(el({ link: 'https://example.com/x' }))?.link).toBe('https://example.com/x')
    expect(sanitizeElement(el({ link: 'javascript:alert(1)' }))?.link).toBeNull()
    expect(sanitizeElement(el({ link: 'data:text/html,hi' }))?.link).toBeNull()
  })

  test('refuses malformed shapes', () => {
    expect(sanitizeElement(null)).toBeNull()
    expect(sanitizeElement([el()])).toBeNull()
    expect(sanitizeElement(el({ id: '../../etc' }))).toBeNull()
    expect(sanitizeElement(el({ version: 0 }))).toBeNull()
    expect(sanitizeElement(el({ versionNonce: 1.5 }))).toBeNull()
    expect(sanitizeElement(el({ x: Number.NaN }))).toBeNull()
    expect(sanitizeElement(el({ width: -1 }))).toBeNull()
    expect(sanitizeElement(el({ x: 1e9 }))).toBeNull()
    expect(sanitizeElement(el({ type: 'line', points: [[0, 0], [1]] }))).toBeNull()
    expect(sanitizeElement(el({ type: 'text', text: 42 }))).toBeNull()
    expect(sanitizeElement(el({ containerId: 7 }))).toBeNull()
  })

  test('caps the size of one element', () => {
    expect(sanitizeElement(el({ type: 'freedraw', points: Array.from({ length: 4001 }, () => [0, 0]) }))).toBeNull()
    expect(sanitizeElement(el({ type: 'text', text: 'x'.repeat(4001) }))).toBeNull()
    expect(sanitizeElement(el({ junk: 'x'.repeat(30_000) }))).toBeNull()
  })

  test('drops custom data and repairs a bad timestamp', () => {
    const out = sanitizeElement(el({ customData: { secret: 1 }, updated: -5 }))
    expect(out && 'customData' in out).toBe(false)
    expect(out?.updated).toBe(0)
  })
})

describe('mergeElements', () => {
  test('the newer version wins, and a tie goes to the lower nonce on every copy', () => {
    expect(newer(el({ version: 2 }), el({ version: 1 }))).toBe(true)
    expect(newer(el({ version: 1 }), el({ version: 2 }))).toBe(false)
    expect(newer(el({ version: 2, versionNonce: 1 }), el({ version: 2, versionNonce: 9 }))).toBe(true)
    expect(newer(el({ version: 2, versionNonce: 9 }), el({ version: 2, versionNonce: 1 }))).toBe(false)
    expect(newer(el(), undefined)).toBe(true)
  })

  test('two copies that receive the same edits in a different order end up the same', () => {
    const a = el({ id: 'x', version: 3, versionNonce: 5, x: 30 })
    const b = el({ id: 'x', version: 3, versionNonce: 2, x: 99 })
    const c = el({ id: 'y', version: 1 })
    const one = mergeElements(mergeElements({}, [a, c]).next, [b]).next
    const two = mergeElements(mergeElements({}, [b]).next, [c, a]).next
    expect(one).toEqual(two)
    expect(one.x?.x).toBe(99)
  })

  test('reports only what changed, and leaves its input alone', () => {
    const start = scene(el({ id: 'x', version: 2 }))
    const { next, changed } = mergeElements(start, [el({ id: 'x', version: 1 }), el({ id: 'y' }), { bogus: true }])
    expect(changed.map((c) => c.id)).toEqual(['y'])
    expect(Object.keys(start)).toEqual(['x'])
    expect(Object.keys(next).sort()).toEqual(['x', 'y'])
  })

  test('a deletion is a newer version, and it sticks', () => {
    const { next } = mergeElements(scene(el({ id: 'x', version: 1 })), [el({ id: 'x', version: 2, isDeleted: true })])
    expect(visible(next)).toEqual([])
    expect(mergeElements(next, [el({ id: 'x', version: 1 })]).changed).toEqual([])
  })

  test('a full board takes edits to known elements but no new ones', () => {
    const full = Object.fromEntries(Array.from({ length: MAX_BOARD_ELEMENTS }, (_, i) => [`e${i}`, el({ id: `e${i}` })]))
    const { changed } = mergeElements(full, [el({ id: 'new' }), el({ id: 'e0', version: 2 })])
    expect(changed.map((c) => c.id)).toEqual(['e0'])
  })
})

describe('chunkElements', () => {
  test('every chunk fits the envelope budget and nothing is lost or reordered', () => {
    const els = Array.from({ length: 300 }, (_, i) => el({ id: `e${i}`, note: 'x'.repeat(400) }))
    const chunks = chunkElements(els)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
    expect(chunks.flat().map((e) => e.id)).toEqual(els.map((e) => e.id))
  })

  test('nothing in, nothing out', () => {
    expect(chunkElements([])).toEqual([])
  })
})

describe('buildElements (agents drawing)', () => {
  test('a labelled shape is a shape and a text bound to it, and both pass sanitizing', () => {
    const els = buildElements([{ kind: 'rectangle', x: 10, y: 20, label: 'Relay' }])
    const shape = els.find((e) => e.type === 'rectangle')
    const label = els.find((e) => e.type === 'text')
    expect(shape && label).toBeTruthy()
    expect(label?.containerId).toBe(shape?.id)
    expect(shape?.boundElements).toEqual([{ type: 'text', id: label?.id }])
    for (const e of els) expect(sanitizeElement(e)).not.toBeNull()
  })

  test('an arrow between two shapes drawn in the same call binds both ends', () => {
    const els = buildElements([
      { kind: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
      { kind: 'ellipse', x: 400, y: 0, width: 100, height: 100 },
      { kind: 'arrow', from: '#0', to: '#1', label: 'sends' },
    ])
    const arrow = els.find((e) => e.type === 'arrow')
    const [a, b] = els.filter((e) => e.type === 'rectangle' || e.type === 'ellipse')
    expect((arrow?.startBinding as { elementId: string }).elementId).toBe(a?.id ?? '')
    expect((arrow?.endBinding as { elementId: string }).elementId).toBe(b?.id ?? '')
    expect((a?.boundElements as { id: string }[]).map((x) => x.id)).toContain(arrow?.id ?? '')
    // it leaves the first box's right edge and arrives at the second one's left edge
    expect(arrow?.x).toBeCloseTo(100)
    expect((arrow?.points as number[][])[1]?.[0]).toBeCloseTo(300)
    expect(els.some((e) => e.type === 'text' && e.containerId === arrow?.id)).toBe(true)
  })

  test('an arrow to a shape already on the board edits that shape as a new version', () => {
    const existing = el({ id: 'box1', boundElements: [] })
    const els = buildElements([{ kind: 'arrow', from: { x: -200, y: 25 }, to: 'box1' }], scene(existing))
    const box = els.find((e) => e.id === 'box1')
    expect(box?.version).toBe(2)
    expect(mergeElements(scene(existing), els).changed.map((e) => e.id)).toContain('box1')
  })

  test('an arrow to something that is not there says so', () => {
    expect(() => buildElements([{ kind: 'arrow', from: 'nope', to: { x: 1, y: 1 } }])).toThrow('cannot find nope')
  })

  test('colours must be colours', () => {
    const [t] = buildElements([{ kind: 'text', x: 0, y: 0, text: 'hi', strokeColor: 'url(javascript:x)' }])
    expect(t?.strokeColor).toBe('#1e1e1e')
  })

  test('arrows start and end on edges', () => {
    expect(edgePoint(el({ x: 0, y: 0, width: 100, height: 100 }), { x: 50, y: 500 })).toEqual({ x: 50, y: 100 })
    expect(edgePoint(el({ x: 0, y: 0, width: 100, height: 100 }), { x: 50, y: 50 })).toEqual({ x: 50, y: 50 })
  })
})

describe('editElements', () => {
  const [shape, label] = buildElements([{ kind: 'rectangle', x: 0, y: 0, width: 200, height: 100, label: 'old' }])
  const s = scene(shape as BoardElement, label as BoardElement)

  test('changing a shape’s text changes its label, as a new version', () => {
    const out = editElements(s, [shape?.id ?? ''], { text: 'new words' })
    const l = out.find((e) => e.id === label?.id)
    expect(l?.text).toBe('new words')
    expect(l?.version).toBe((label?.version ?? 0) + 1)
  })

  test('moving a shape takes its label along', () => {
    const out = editElements(s, [shape?.id ?? ''], { x: 50, y: 10 })
    expect(out.find((e) => e.id === shape?.id)?.x).toBe(50)
    expect(out.find((e) => e.id === label?.id)?.x).toBe((label?.x ?? 0) + 50)
  })

  test('deleting a shape deletes its label', () => {
    const out = editElements(s, [shape?.id ?? ''], 'delete')
    expect(out.every((e) => e.isDeleted)).toBe(true)
    expect(out).toHaveLength(2)
  })

  test('refuses what cannot be done', () => {
    expect(() => editElements(s, ['missing'], { x: 1 })).toThrow('no element missing')
    expect(() => editElements(s, [shape?.id ?? ''], { x: Number.NaN })).toThrow('x must be a number')
    const plain = el({ id: 'p' })
    expect(() => editElements(scene(plain), ['p'], { text: 'hi' })).toThrow('has no text')
  })
})

describe('summarize', () => {
  test('one line per thing on the board, labels inline, arrows with their ends', () => {
    const els = buildElements([
      { kind: 'rectangle', x: 0, y: 0, label: 'Relay' },
      { kind: 'rectangle', x: 300, y: 0, label: 'Council' },
      { kind: 'arrow', from: '#0', to: '#1' },
    ])
    const text = summarize(scene(...els))
    expect(text).toStartWith('3 elements on the board:')
    expect(text).toContain('"Relay"')
    expect(text).toMatch(/arrow .* from \w+ to \w+/)
  })

  test('an empty board says so', () => {
    expect(summarize({})).toBe('The board is empty.')
    expect(summarize(scene(el({ isDeleted: true })))).toBe('The board is empty.')
  })
})
