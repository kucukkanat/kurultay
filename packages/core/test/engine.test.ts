import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey, routeTag, routeWindow, signInner, unwrapGroup, wrapGroup, getPublicKey, randomHex } from '../src'
import { startTestRelay, type TestRelay } from '../src/testing/relay'

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

async function peer(name: string, kind: 'human' | 'agent') {
  const p = new Kurultay({ sk: newSecretKey(), name, kind, relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
  peers.push(p)
  await p.start()
  await until(() => p.pool.relays.every((r) => r.status === 'open'))
  return p
}

describe('crypto', () => {
  test('route tags rotate per slot and differ per secret', () => {
    const a = randomHex(32)
    const b = randomHex(32)
    expect(routeTag(a, 'group', 1)).not.toBe(routeTag(a, 'group', 2))
    expect(routeTag(a, 'group', 1)).not.toBe(routeTag(b, 'group', 1))
    expect(routeTag(a, 'group', 1)).not.toBe(routeTag(a, 'inbox', 1))
    expect(routeWindow(a, 'group')).toHaveLength(3)
  })

  test('group wrap hides author and content, binds to group', () => {
    const sk = newSecretKey()
    const key = randomHex(32)
    const inner = signInner(sk, { type: 'chat', text: 'secret plans' }, ['g', 'g1'])
    const outer = wrapGroup(inner, key)
    expect(outer.pubkey).not.toBe(getPublicKey(sk))
    expect(outer.content).not.toContain('secret')
    expect(unwrapGroup(outer, 'g1', key).env).toEqual({ type: 'chat', text: 'secret plans' })
    expect(() => unwrapGroup(outer, 'g2', key)).toThrow()
    expect(() => unwrapGroup(outer, 'g1', randomHex(32))).toThrow()
  })
})

describe('engine', () => {
  test('invite, join, mention, and what the relay sees', async () => {
    const alice = await peer('alice', 'human')
    const bot = await peer('reviewer', 'agent')
    const g = alice.createGroup('infra-council')
    const link = alice.createInvite(g.id)
    const res = await bot.redeem(link)
    expect(res.status).toBe('awaiting-admin')
    await until(() => bot.state.groups[g.id])
    expect(Object.keys(bot.state.groups[g.id].roster.members)).toHaveLength(2)

    const got: string[] = []
    bot.on('message', (m) => m.forMe && got.push(m.message.text))
    await alice.send(g.id, 'hello everyone')
    await alice.send(g.id, '@reviewer please look at PR 42')
    await until(() => got.length === 1)
    expect(got[0]).toContain('PR 42')
    await until(() => bot.state.groups[g.id].history.some((m) => m.text === 'hello everyone'))

    // relay view: only ephemeral wrap events, signed by throwaway keys, no plaintext, nothing stored
    expect(relay.stored).toHaveLength(0)
    const authors = new Set(relay.observed.map((e) => e.pubkey))
    expect(authors.has(alice.pubkey)).toBe(false)
    expect(authors.has(bot.pubkey)).toBe(false)
    for (const e of relay.observed) {
      expect(e.kind).toBe(21059)
      expect(e.content).not.toContain('PR 42')
      expect(e.tags.every((t) => t[0] === 'z')).toBe(true)
    }
  })

  test('agent join requires owner approval; members see verification', async () => {
    const tolga = await peer('tolga', 'human')
    const admin = await peer('admin', 'human')
    const cc = await peer('claude-code', 'agent')
    const code = tolga.createPairCode('claude-code#1')
    await cc.redeem(code)
    await until(() => cc.state.owner?.attestation)
    expect(tolga.state.agents[cc.pubkey].label).toBe('claude-code#1')

    const g = admin.createGroup('design')
    const approvals: string[] = []
    tolga.on('approval', (a) => approvals.push(a.reqId))
    const res = await cc.redeem(admin.createInvite(g.id))
    expect(res.status).toBe('awaiting-owner')
    await until(() => approvals.length === 1)
    expect(cc.state.groups[g.id]).toBeUndefined()
    await tolga.approve(approvals[0], true)
    await until(() => cc.state.groups[g.id])
    await until(() => admin.member(g.id, cc.pubkey)?.verified)
    expect(admin.member(g.id, cc.pubkey)!.verified!.ownerName).toBe('tolga')
  })

  test('admin approval for non-auto invites, and deny', async () => {
    const admin = await peer('boss', 'human')
    const x = await peer('x', 'agent')
    const g = admin.createGroup('private')
    const approvals: string[] = []
    admin.on('approval', (a) => approvals.push(a.reqId))
    await x.redeem(admin.createInvite(g.id, { autoAdmit: false }))
    await until(() => approvals.length === 1)
    await admin.approve(approvals[0], false)
    await until(() => Object.values(x.state.pendingJoins)[0]?.status === 'denied')
    expect(x.state.groups[g.id]).toBeUndefined()
  })

  test('removing a member rotates the key; removed member is cut off', async () => {
    const admin = await peer('chief', 'human')
    const a = await peer('a', 'agent')
    const b = await peer('b', 'agent')
    const g = admin.createGroup('ops')
    const inv = admin.createInvite(g.id)
    await a.redeem(inv)
    await b.redeem(inv)
    await until(() => a.state.groups[g.id] && b.state.groups[g.id])
    await until(() => Object.keys(a.state.groups[g.id].roster.members).length === 3)

    await admin.removeMember(g.id, b.pubkey)
    await until(() => !b.state.groups[g.id])
    await until(() => a.state.groups[g.id].epoch === 1)
    expect(a.state.groups[g.id].key).toBe(admin.state.groups[g.id].key)

    await admin.send(g.id, '@a after rotation')
    await until(() => a.state.groups[g.id].history.some((m) => m.text.includes('after rotation')))
  })

  test('pause blocks agents, tasks round-trip, rate limits apply', async () => {
    const admin = await peer('mod', 'human')
    const bot = await peer('worker', 'agent')
    const g = admin.createGroup('tasks')
    await bot.redeem(admin.createInvite(g.id))
    await until(() => bot.state.groups[g.id])

    const taskId = await admin.sendTask(g.id, 'worker', 'Summarize the incident', 'logs attached')
    await until(() => bot.state.groups[g.id]?.tasks[taskId])
    await bot.updateTask(g.id, taskId, 'done', 'All good')
    await until(() => admin.state.groups[g.id].tasks[taskId].status === 'done')

    await admin.moderate(g.id, 'pause')
    await until(() => bot.state.groups[g.id].roster.paused)
    await expect(bot.send(g.id, 'hi')).rejects.toThrow(/paused/)
    await admin.moderate(g.id, 'resume')
    await until(() => !bot.state.groups[g.id].roster.paused)

    let err: Error | undefined
    for (let i = 0; i < 20 && !err; i++) await bot.send(g.id, `spam ${i}`).catch((e) => (err = e))
    expect(err?.message).toMatch(/Rate limit/)
  })

  test('DMs are two-member groups', async () => {
    const admin = await peer('host', 'human')
    const bot = await peer('helper', 'agent')
    const g = admin.createGroup('lobby')
    await bot.redeem(admin.createInvite(g.id))
    await until(() => bot.state.groups[g.id])
    const dm = await admin.openDM(bot.pubkey)
    await until(() => bot.state.groups[dm])
    const got: boolean[] = []
    bot.on('message', (m) => m.groupId === dm && got.push(m.forMe))
    await admin.send(dm, "no mention needed in a DM")
    await until(() => got.length === 1)
    expect(got[0]).toBe(true)
  })
})
