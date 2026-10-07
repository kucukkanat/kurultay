import { expect, test } from 'bun:test'
import type { Message } from '@kurultay/core'
import { replyTarget, splitThreads } from './threads'

const msg = (id: string, from: string, thread?: string, type: Message['type'] = 'chat'): Message => ({ id, groupId: 'g', from, ts: 1, type, text: id, thread })
const ids = (ms: readonly Message[] | undefined) => (ms ?? []).map((m) => m.id)

test('replies leave the main chat and gather under their root, oldest first', () => {
  const { feed, replies } = splitThreads([msg('a', 'bob'), msg('b', 'amy'), msg('r1', 'me', 'a'), msg('r2', 'bob', 'a'), msg('c', 'bob')])
  expect(ids(feed)).toEqual(['a', 'b', 'c'])
  expect(ids(replies.get('a'))).toEqual(['r1', 'r2'])
  expect(replies.has('b')).toBe(false)
})

test('a reply to a reply stays in the same flat thread', () => {
  const { feed, replies } = splitThreads([msg('a', 'bob'), msg('r1', 'me', 'a'), msg('r2', 'bob', 'r1'), msg('r3', 'me', 'r2')])
  expect(ids(feed)).toEqual(['a'])
  expect(ids(replies.get('a'))).toEqual(['r1', 'r2', 'r3'])
})

test('a reply whose original is gone stays visible in the main chat', () => {
  expect(ids(splitThreads([msg('lost-reply', 'bob', 'missing')]).feed)).toEqual(['lost-reply'])
})

test('system lines and tasks are never threaded, and a cycle of ids cannot hang', () => {
  const t = splitThreads([msg('a', 'bob'), msg('sys', '', 'a', 'system'), msg('t', 'bob', 'a', 'task'), msg('x', 'bob', 'y'), msg('y', 'bob', 'x')])
  expect(ids(t.feed)).toEqual(expect.arrayContaining(['sys', 't']))
  expect(t.feed.length + [...t.replies.values()].flat().length).toBe(5)
})

test('a reply goes to the newest message from someone else, so an agent in the thread is notified', () => {
  const root = msg('a', 'me')
  const agent = msg('r1', 'bot', 'a')
  const mine = msg('r2', 'me', 'r1')
  expect(replyTarget(root, [], 'me')).toBe(root)
  expect(replyTarget(root, [agent, mine], 'me')).toBe(agent)
  expect(replyTarget(root, [mine], 'me')).toBe(root)
})
