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

describe('key rotation', () => {
  async function council(name: string) {
    const admin = await peer(`${name}-admin`, 'human')
    const alice = await peer(`${name}-alice`, 'human')
    const g = admin.createGroup(name)
    await alice.redeem(admin.createInvite(g.id))
    await until(() => alice.state.groups[g.id])
    return { admin, alice, id: g.id }
  }

  test('an admin rotates: both sides move to the new key and keep talking', async () => {
    const { admin, alice, id } = await council('rot')
    const old = admin.state.groups[id].key
    await admin.rotateKey(id)
    const g = admin.state.groups[id]
    expect(g.epoch).toBe(1)
    expect(g.key).not.toBe(old)
    expect(g.rotatedAt).toBeGreaterThan(0)
    expect(g.history.some((m) => m.type === 'system' && m.text.includes('rotated the group key'))).toBe(true)
    await until(() => alice.state.groups[id].epoch === 1)
    expect(alice.state.groups[id].key).toBe(g.key)
    expect(alice.state.groups[id].rotatedAt).toBeGreaterThan(0)
    await admin.send(id, 'from admin')
    await alice.send(id, 'from alice')
    await until(() => alice.state.groups[id].history.some((m) => m.text === 'from admin'))
    await until(() => admin.state.groups[id].history.some((m) => m.text === 'from alice'))
  })

  test('only admins rotate, and never a DM', async () => {
    const { admin, alice, id } = await council('rot-guard')
    await expect(alice.rotateKey(id)).rejects.toThrow(/Only admins/)
    expect(admin.state.groups[id].epoch).toBe(0)
    const dm = await admin.openDM(alice.pubkey)
    await expect(admin.rotateKey(dm)).rejects.toThrow(/direct message/)
  })

  test('a leaked copy of the old key cannot read messages sent after rotation', async () => {
    const { admin, alice, id } = await council('rot-leak')
    const leaked = admin.state.groups[id].key
    await admin.rotateKey(id)
    await until(() => alice.state.groups[id].epoch === 1)
    const before = relay.observed.length
    await admin.send(id, 'post-rotation secret')
    await until(() => alice.state.groups[id].history.some((m) => m.text === 'post-rotation secret'))
    const after = relay.observed.slice(before)
    const opens = (key: string) => after.filter((e) => { try { return unwrapGroup(e, id, key).env.type === 'chat' } catch { return false } })
    expect(opens(admin.state.groups[id].key).length).toBeGreaterThan(0)
    expect(opens(leaked)).toHaveLength(0)
  })

  test('a member offline during rotation catches up through sync on restart', async () => {
    const admin = await peer('rot-off-admin', 'human')
    const sk = newSecretKey()
    const storage = new MemoryStorage()
    const make = () => new Kurultay({ sk, name: 'sleeper', kind: 'human', relays: [relay.url], storage, presenceInterval: 3_600_000 })
    const first = make()
    await first.start()
    const g = admin.createGroup('rot-offline')
    await first.redeem(admin.createInvite(g.id))
    await until(() => first.state.groups[g.id])
    await first.stop()
    await admin.rotateKey(g.id)
    const back = make()
    peers.push(back)
    await back.start()
    await until(() => back.state.groups[g.id]?.epoch === 1)
    expect(back.state.groups[g.id].key).toBe(admin.state.groups[g.id].key)
  })

  test('removal shares the rotation path: new epoch, rotatedAt set, removed member told', async () => {
    const { admin, alice, id } = await council('rot-remove')
    await admin.removeMember(id, alice.pubkey)
    expect(admin.state.groups[id].epoch).toBe(1)
    expect(admin.state.groups[id].rotatedAt).toBeGreaterThan(0)
    await until(() => !alice.state.groups[id])
  })
})

describe('agent tickets', () => {
  async function agentFromTicket(ticket: string, host: string, name: string) {
    const { decodeTicket } = await import('../src/links')
    const t = decodeTicket(ticket)
    const { sk, state } = Kurultay.fromTicket(t, host)
    const storage = new MemoryStorage()
    storage.save(state)
    const p = new Kurultay({ sk, name, kind: 'agent', relays: [relay.url], storage, presenceInterval: 3_600_000 })
    peers.push(p)
    await p.start()
    return p
  }

  test('owner who is admin: one ticket seats the agent, verified, without approvals', async () => {
    const tolga = await peer('tolga', 'human')
    const g = tolga.createGroup('ops-council')
    const ticket = tolga.createTicket([g.id])
    expect(ticket.startsWith('kurultay:')).toBe(true)
    const cc = await agentFromTicket(ticket, 'claude', 'claude@laptop')
    await until(() => cc.state.groups[g.id])
    expect(Object.keys(tolga.state.approvals)).toHaveLength(0)
    const v = tolga.member(g.id, cc.pubkey)!
    expect(v.verified?.ownerName).toBe('tolga')
    expect(v.verified?.label).toBe('claude')
    expect(tolga.ticketProgress(Object.keys(tolga.state.tickets!)[0])).toHaveLength(1)
  })

  test('owner invited to someone else’s council: admin admits the member’s agent automatically', async () => {
    const admin = await peer('chair', 'human')
    const alice = await peer('alice', 'human')
    const g = admin.createGroup('shared')
    await alice.redeem(admin.createInvite(g.id))
    await until(() => alice.state.groups[g.id] && Object.keys(admin.state.groups[g.id].roster.members).length === 2)
    const ticket = alice.createTicket([g.id])
    const [codex, pi] = await Promise.all([agentFromTicket(ticket, 'codex', 'codex@box'), agentFromTicket(ticket, 'pi', 'pi@box')])
    await until(() => codex.state.groups[g.id] && pi.state.groups[g.id])
    expect(admin.member(g.id, codex.pubkey)?.verified?.owner).toBe(alice.pubkey)
    expect(codex.pubkey).not.toBe(pi.pubkey)

    // the chair can't pull alice's agent into a council alice isn't in
    const side = admin.createGroup('side-room')
    await admin.addKnownMember(side.id, codex.pubkey)
    await Bun.sleep(800)
    expect(codex.state.groups[side.id]).toBeUndefined()
    // but a DM works
    const dm = await admin.openDM(codex.pubkey)
    await until(() => codex.state.groups[dm])
  })

  test('strangers and disabled councils are refused', async () => {
    const admin = await peer('gate', 'human')
    const outsider = await peer('outsider', 'human')
    const g = admin.createGroup('closed')
    // outsider is not a member: their ticket lists the council but admission is denied
    const fake = outsider.createTicket([])
    const { decodeTicket, encodeTicket } = await import('../src/links')
    const t = decodeTicket(fake)
    t.groups = [{ groupId: g.id, name: 'closed', relays: [relay.url], admins: [{ pubkey: admin.pubkey, inbox: admin.state.inbox }] }]
    const bot = await agentFromTicket(encodeTicket(t), 'claude', 'intruder')
    await until(() => Object.values(bot.state.pendingJoins)[0]?.status === 'denied')
    expect(admin.state.groups[g.id].roster.members[bot.pubkey]).toBeUndefined()
  })

  test('no duplicates: tickets reuse identities, and an older identity for the same host is replaced', async () => {
    const owner = await peer('dup-owner', 'human')
    const g = owner.createGroup('nodup')
    const t1 = owner.createTicket([g.id], { hosts: ['claude'] })
    const t2 = owner.createTicket([g.id], { hosts: ['claude'] })
    const { decodeTicket } = await import('../src/links')
    expect(decodeTicket(t1).seed).toBe(decodeTicket(t2).seed)
    expect(decodeTicket(t1).hosts).toEqual(['claude'])
    const a = await agentFromTicket(t1, 'claude', 'claude@mbp')
    await until(() => a.state.groups[g.id])
    const again = await agentFromTicket(t2, 'claude', 'claude@mbp')
    await until(() => again.state.groups[g.id])
    expect(owner.members(g.id).filter((m) => m.kind === 'agent')).toHaveLength(1)

    // an identity from an older seed (e.g. a previous version) for the same host gets replaced, not duplicated
    owner.state.agentSeed = undefined
    const fresh = owner.createTicket([g.id])
    const newer = await agentFromTicket(fresh, 'claude', 'claude@mbp')
    await until(() => newer.state.groups[g.id] && !owner.state.groups[g.id].roster.members[a.pubkey])
    const agents = owner.members(g.id).filter((m) => m.kind === 'agent')
    expect(agents.map((m) => m.pubkey)).toEqual([newer.pubkey])
  })

  test('a removed agent stays out: its old ticket is refused, a new ticket mints fresh identities', async () => {
    const owner = await peer('rm-owner', 'human')
    const g = owner.createGroup('revoke')
    const t1 = owner.createTicket([g.id], { hosts: ['codex'] })
    const a = await agentFromTicket(t1, 'codex', 'codex@leak')
    await until(() => a.state.groups[g.id])
    await owner.removeMember(g.id, a.pubkey)
    expect(owner.state.groups[g.id].roster.removed).toContain(a.pubkey)
    // the leaked ticket no longer seats anyone
    const replay = await agentFromTicket(t1, 'codex', 'codex@thief')
    await until(() => Object.values(replay.state.pendingJoins)[0]?.status === 'denied')
    expect(owner.state.groups[g.id].roster.members[replay.pubkey]).toBeUndefined()
    // a new ticket comes with new identities and works
    const t2 = owner.createTicket([g.id], { hosts: ['codex'] })
    const { decodeTicket } = await import('../src/links')
    expect(decodeTicket(t2).seed).not.toBe(decodeTicket(t1).seed)
    const b = await agentFromTicket(t2, 'codex', 'codex@new')
    await until(() => b.state.groups[g.id])
    expect(b.pubkey).not.toBe(a.pubkey)
  })

  test('owner renames an agent: it goes by the new name in every council, also where someone else is admin', async () => {
    const owner = await peer('namer', 'human')
    const chair = await peer('chair2', 'human')
    const mine = owner.createGroup('mine')
    const theirs = chair.createGroup('theirs')
    await owner.redeem(chair.createInvite(theirs.id))
    await until(() => owner.state.groups[theirs.id])
    const t = owner.createTicket([mine.id, theirs.id], { hosts: ['codex'] })
    const a = await agentFromTicket(t, 'codex', 'codex@box')
    await until(() => a.state.groups[mine.id] && a.state.groups[theirs.id])
    await expect(owner.renameAgent(a.pubkey, 'bad name!')).rejects.toThrow()
    await owner.renameAgent(a.pubkey, 'reviewer')
    await until(() => owner.member(mine.id, a.pubkey)?.name === 'reviewer' && chair.member(theirs.id, a.pubkey)?.name === 'reviewer')
    expect(a.name).toBe('reviewer')
    expect(a.state.agentSettings?.name).toBe('reviewer')
    // @reviewer reaches it
    const got: string[] = []
    a.on('message', (m) => m.forMe && got.push(m.message.text))
    await chair.send(theirs.id, '@reviewer please look')
    await until(() => got.length === 1)
  })
})
