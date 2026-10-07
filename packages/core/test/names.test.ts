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

const pk = (index: number) => index.toString(16).padStart(8, '0') + 'ab'.repeat(28)

test('the pubkey picks the name, so every machine seating one identity agrees on it', () => {
  expect(pickPlayfulName(pk(0))).toBe(PLAYFUL_NAMES[0])
  expect(pickPlayfulName(pk(PLAYFUL_NAMES.length - 1))).toBe(PLAYFUL_NAMES[PLAYFUL_NAMES.length - 1])
  expect(pickPlayfulName(pk(PLAYFUL_NAMES.length + 2))).toBe(PLAYFUL_NAMES[2])
  expect(pickPlayfulName(pk(5))).toBe(pickPlayfulName(pk(5)))
})

test('taken names step to the next free entry regardless of case or @machine suffix, wrapping at the end', () => {
  const [first, second, third] = PLAYFUL_NAMES
  expect(pickPlayfulName(pk(0), [first.toUpperCase(), `${second}@box`])).toBe(third)
  expect(pickPlayfulName(pk(PLAYFUL_NAMES.length - 1), [PLAYFUL_NAMES[PLAYFUL_NAMES.length - 1]])).toBe(first)
})

test('once every plain name is used, a numbered one is returned and stays unique', () => {
  const taken: string[] = [...PLAYFUL_NAMES]
  const a = pickPlayfulName(pk(3), taken)
  expect(a).toBe(`${PLAYFUL_NAMES[3]}-2`)
  const b = pickPlayfulName(pk(3), [...taken, a])
  expect(b).toBe(`${PLAYFUL_NAMES[3]}-3`)
  expect(cleanName(b)).toBe(b)
})
