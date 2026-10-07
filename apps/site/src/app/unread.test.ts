import { expect, test } from 'bun:test'
import type { GroupState, Message } from '@kurultay/core'
import { isForMe, unreadSummary } from './unread'

const me = 'me'
const msg = (id: string, from: string, ts: number, o: Partial<Message> = {}): Message => ({ id, groupId: 'g', from, ts, type: 'chat', text: id, ...o })
const member = (pubkey: string, kind: 'human' | 'agent') => ({ pubkey, name: pubkey, kind, inbox: '00', role: 'member' as const, joinedAt: 0 })
const group = (history: Message[], dm = false): Pick<GroupState, 'history' | 'roster'> => ({
  history,
  roster: { version: 1, name: 'ops', dm, admins: ['amy'], paused: false, muted: [], members: { me: member(me, 'human'), amy: member('amy', 'human'), bot: member('bot', 'agent') } },
})

test('counts only messages from others, skipping mine and system lines', () => {
  const g = group([msg('a', 'amy', 10), msg('b', me, 11), msg('c', '', 12, { type: 'system' }), msg('d', 'bot', 13)])
  expect(unreadSummary(g, 0, me)).toEqual({ count: 2, mentions: 0 })
})

test('the read timestamp is exclusive: a message at that second is already read', () => {
  const g = group([msg('a', 'amy', 10), msg('b', 'amy', 11)])
  expect(unreadSummary(g, 10, me).count).toBe(1)
  expect(unreadSummary(g, 11, me).count).toBe(0)
})

test('a mention of me, @all, a task to me and every DM message are for me', () => {
  const g = group([msg('a', 'amy', 1, { mentions: [me] }), msg('b', 'amy', 2, { mentions: ['all'] }), msg('c', 'amy', 3, { type: 'task', mentions: [me] }), msg('d', 'amy', 4, { mentions: ['bot'] })])
  expect(unreadSummary(g, 0, me)).toEqual({ count: 4, mentions: 3 })
  const dm = group([msg('a', 'amy', 1)], true)
  expect(isForMe(dm, dm.history[0], me)).toBe(true)
  expect(isForMe(dm, msg('x', me, 2), me)).toBe(false)
})

test('a reply to my message counts as for me, like the engine says', () => {
  const g = group([msg('root', me, 1), msg('r', 'bot', 2, { thread: 'root' })])
  expect(isForMe(g, g.history[1], me)).toBe(true)
})
