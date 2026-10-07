// Integration: two real engines over an in-process relay. What B's alerts and unread badge say must match what the
// engine itself decided was for B (its `forMe`), so the sound and the @ badge never disagree.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'
import { startTestRelay, type TestRelay } from '@kurultay/core/testing'
import { planAlert } from './notify'
import { DEFAULT_PREFS } from './prefs'
import { isForMe, unreadSummary } from './unread'

let relay: TestRelay
const peers: Kurultay[] = []
beforeAll(() => {
  relay = startTestRelay(0)
})
afterAll(async () => {
  await Promise.all(peers.map((p) => p.stop()))
  relay.stop()
})

async function until(cond: () => unknown, ms = 4000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await Bun.sleep(20)
  }
}

async function peer(name: string) {
  const p = new Kurultay({ sk: newSecretKey(), name, kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
  peers.push(p)
  await p.start()
  await until(() => p.pool.relays.every((r) => r.status === 'open'))
  return p
}

test('a plain message chimes, a mention of me rings, and both count as unread', async () => {
  const amy = await peer('amy')
  const bo = await peer('bo')
  const g = amy.createGroup('notify')
  await bo.redeem(amy.createInvite(g.id))
  await until(() => bo.state.groups[g.id]?.roster.members[amy.pubkey])

  const sounds: (string | null)[] = []
  const agree: boolean[] = []
  bo.on('message', ({ groupId, message, forMe }) => {
    if (groupId !== g.id || !message.from || message.from === bo.pubkey) return
    sounds.push(planAlert({ prefs: DEFAULT_PREFS, forMe, viewing: false, visible: true, focused: true }).sound)
    agree.push(isForMe(bo.state.groups[g.id], message, bo.pubkey) === forMe)
  })
  await amy.send(g.id, 'hello all')
  await until(() => sounds.length === 1)
  await amy.send(g.id, '@bo can you look?')
  await until(() => sounds.length === 2)
  expect(sounds).toEqual(['message', 'mention'])
  expect(agree).toEqual([true, true])
  expect(unreadSummary(bo.state.groups[g.id], 0, bo.pubkey)).toEqual({ count: 2, mentions: 1 })

  // @all is for everyone; my own messages never count, in my unread or anyone's alerts
  await amy.send(g.id, '@all standup in 5')
  await bo.send(g.id, 'on my way')
  await until(() => amy.state.groups[g.id].history.some((m) => m.text === 'on my way'))
  await until(() => sounds.length === 3)
  expect(sounds[2]).toBe('mention')
  expect(unreadSummary(bo.state.groups[g.id], 0, bo.pubkey)).toEqual({ count: 3, mentions: 2 })
  expect(unreadSummary(amy.state.groups[g.id], 0, amy.pubkey).count).toBe(1)
})
