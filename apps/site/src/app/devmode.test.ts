import { describe, expect, test } from 'bun:test'
import { advance, DEV_WORD } from './devmode'

/** Feed a key sequence through `advance` and count the hits, keeping every intermediate buffer. */
const run = (keys: readonly string[]) =>
  keys.reduce<{ buffer: string; hits: number; buffers: readonly string[] }>(
    (acc, key) => {
      const r = advance(acc.buffer, key)
      return { buffer: r.buffer, hits: acc.hits + (r.matched ? 1 : 0), buffers: [...acc.buffers, r.buffer] }
    },
    { buffer: '', hits: 0, buffers: [] },
  )

describe('advance', () => {
  test('the word is kurultaydev', () => expect(DEV_WORD).toBe('kurultaydev'))
  test('matches once, and twice when typed twice in a row', () => {
    expect(run([...'kurultaydev']).hits).toBe(1)
    expect(run([...'kurultaydevkurultaydev']).hits).toBe(2)
  })
  test('leading noise and capitals still match', () => expect(run([...'hello KurultayDev']).hits).toBe(1))
  test('named keys in the middle are ignored', () => expect(run(['k', 'u', 'Shift', 'r', 'ArrowLeft', ...'ultaydev']).hits).toBe(1))
  test('a wrong letter in the middle breaks the word', () => expect(run([...'kurulXtaydev']).hits).toBe(0))
  test('the buffer never grows past the word length', () => {
    expect(Math.max(...run([...'the quick brown fox jumps over kurultay']).buffers.map((b) => b.length))).toBe(DEV_WORD.length)
  })
  test('a custom word works too', () => expect(advance('ab', 'c', 'abc')).toEqual({ buffer: '', matched: true }))
})
