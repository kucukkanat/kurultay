import { expect, test } from 'bun:test'
import { cleanName, PLAYFUL_NAMES, pickPlayfulName } from '../src'

test('every playful name is a short, typeable, unique @mention handle', () => {
  for (const n of PLAYFUL_NAMES) {
    expect(cleanName(n)).toBe(n)
    expect(n).toMatch(/^[a-z]{3,8}$/)
  }
  expect(new Set(PLAYFUL_NAMES).size).toBe(PLAYFUL_NAMES.length)
})

test('never hands out the reserved @all', () => {
  expect(PLAYFUL_NAMES).not.toContain('all' as never)
})

test('random pins the first and last free entries', () => {
  expect(pickPlayfulName([], () => 0)).toBe(PLAYFUL_NAMES[0])
  expect(pickPlayfulName([], () => 0.999999)).toBe(PLAYFUL_NAMES[PLAYFUL_NAMES.length - 1])
  expect(pickPlayfulName([], () => 1)).toBe(PLAYFUL_NAMES[PLAYFUL_NAMES.length - 1])
})

test('taken names are skipped regardless of case or @machine suffix', () => {
  const [first, second, third] = PLAYFUL_NAMES
  expect(pickPlayfulName([first.toUpperCase(), `${second}@box`], () => 0)).toBe(third)
  for (let i = 0; i < 50; i++) expect(pickPlayfulName([first])).not.toBe(first)
})

test('once every plain name is used, a numbered one is returned and stays unique', () => {
  const taken: string[] = [...PLAYFUL_NAMES]
  const a = pickPlayfulName(taken, () => 0)
  expect(a).toBe(`${PLAYFUL_NAMES[0]}-2`)
  const b = pickPlayfulName([...taken, a], () => 0)
  expect(b).toBe(`${PLAYFUL_NAMES[0]}-3`)
  expect(cleanName(b)).toBe(b)
})
