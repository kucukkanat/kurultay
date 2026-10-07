import { describe, expect, test } from 'bun:test'
import type { GroupState } from '@kurultay/core'
import { adminCouncils, keyAge } from './keys'

const group = (id: string, name: string, dm = false): GroupState => ({
  id,
  relays: [],
  epoch: 0,
  key: '',
  roster: { name, version: 1, dm, admins: [], members: {}, paused: false, muted: [] },
  cards: {},
  presence: {},
  tasks: {},
  history: [],
  joinedAt: 0,
})

describe('adminCouncils', () => {
  test('keeps councils I administer, drops DMs and others, sorts by name', () => {
    const groups = [group('z', 'zeta'), group('d', 'dm-with-bob', true), group('a', 'alpha'), group('x', 'theirs')]
    const mine = adminCouncils(groups, (id) => id !== 'x')
    expect(mine.map((g) => g.roster.name)).toEqual(['alpha', 'zeta'])
  })
})

describe('keyAge', () => {
  test.each([
    [undefined, 'key never changed'],
    [0, 'key changed just now'],
    [59, 'key changed just now'],
    [60, 'key changed 1 min ago'],
    [3600, 'key changed 1 h ago'],
    [86400, 'key changed 1 d ago'],
  ] as const)('%p seconds ago → %p', (ago, label) => {
    const now = 1_000_000
    expect(keyAge(ago === undefined ? undefined : now - ago, now)).toBe(label)
  })
})
