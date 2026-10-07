// Integration: an owner and its agent seated over a real in-process relay. The switches send one of the five modes, so
// the agent's engine (and what it reports back) must land on exactly the mode the switches show. The page part runs in
// happy-dom, registered only after both engines are connected so their sockets stay Bun's native WebSocket.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { decodeTicket, Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'
import { modeAfterToggle } from './permissions'

const relay = startTestRelay(0)
const until = async (cond: () => unknown, ms = 5000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await Bun.sleep(20)
  }
}
const boot = async (e: Kurultay) => {
  await e.start()
  await until(() => e.pool.relays.every((r) => r.status === 'open'))
  return e
}

const owner = new Kurultay({ sk: newSecretKey(), name: 'tolga', kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
let agent: Kurultay

beforeAll(async () => {
  await boot(owner)
  const g = owner.createGroup('ops')
  const { sk, state } = Kurultay.fromTicket(decodeTicket(owner.createTicket([g.id], { hosts: ['claude'] })), 'claude')
  const storage = new MemoryStorage()
  storage.save(state)
  agent = await boot(new Kurultay({ sk, name: 'claude', kind: 'agent', relays: [relay.url], storage, presenceInterval: 3_600_000 }))
  await until(() => owner.member(g.id, agent.pubkey)?.verified)
  GlobalRegistrator.register({ url: 'http://localhost:5173/app/' })
  // point the page's daemon client at a closed port so it never talks to a real service on this machine
  localStorage.setItem('kurultay:daemon-port', '1')
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
  await Promise.all([owner.stop(), agent.stop()])
  relay.stop()
})

/** the agent applies what it was sent and reports back, as the background service does */
const reported = async (mode: string) => {
  await until(() => agent.agentMode === mode)
  await agent.reportStatus({ background: true, headless: true, workdir: '/w', running: false })
  await until(() => owner.state.agentStatus?.[agent.pubkey]?.mode === mode)
}

test('a toggled switch reaches the agent as one of the five modes', async () => {
  expect(agent.agentMode).toBe('talk')
  await owner.setAgentMode(agent.pubkey, modeAfterToggle('talk', 'edit', true))
  await reported('edit')
  await owner.setAgentMode(agent.pubkey, modeAfterToggle('edit', 'read', false))
  await reported('talk')
})

test('in the agent card, Run commands brings every switch below it along and Answer off turns everything off', async () => {
  const { render } = await import('preact')
  const { AgentsList } = await import('./agents')
  const root = document.body.appendChild(document.createElement('div'))
  const draw = () => render(<AgentsList e={owner} />, root)
  const off = owner.on('change', draw)
  draw()
  const sw = (id: string) => {
    const el = root.querySelector<HTMLInputElement>(`[data-testid="perm-${id}"] input`)
    if (!el) throw new Error(`no perm-${id} switch`)
    return el
  }
  expect([sw('answer').checked, sw('read').checked]).toEqual([true, false])
  // Run commands rather than Edit: the first test already sent "edit", and an identical settings event within the same
  // second has the same id, which the relay drops as a duplicate
  sw('run').click()
  await reported('full')
  expect(['answer', 'read', 'edit', 'run'].map((id) => sw(id).checked)).toEqual([true, true, true, true])
  sw('answer').click()
  await reported('off')
  expect(['answer', 'read', 'edit', 'run'].map((id) => sw(id).checked)).toEqual([false, false, false, false])
  off()
  render(null, root)
  root.remove()
})
