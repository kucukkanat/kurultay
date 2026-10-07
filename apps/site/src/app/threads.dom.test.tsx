// Integration: the thread link and panel rendered into happy-dom, driving a real (offline) engine. Registered only for this
// file so the packages tests keep Bun's native fetch and WebSocket.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey, type Message } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'

// a local relay, so the engine never reaches for the public defaults
const relay = startTestRelay(0)
const engines: Kurultay[] = []
beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost:5173/app/' }))
afterAll(() => {
  engines.forEach((e) => e.pool.close())
  GlobalRegistrator.unregister()
  relay.stop()
})

const byId = <T extends HTMLElement = HTMLElement>(id: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  return el
}
const settle = () => new Promise((r) => setTimeout(r, 30))
const BOT = 'b'.repeat(64)

/** Me in a council where I asked something and an agent answered in the thread. */
async function council() {
  const e = new Kurultay({ sk: newSecretKey(), name: 'amy', kind: 'human', relays: [relay.url], storage: new MemoryStorage() })
  engines.push(e)
  const g = e.createGroup('ops')
  const chat = (id: string, from: string, thread?: string): Message => ({ id, groupId: g.id, from, ts: 1_700_000_000, type: 'chat', text: `msg ${id}`, thread })
  g.history.push(chat('q', e.pubkey), chat('a1', BOT, 'q'), chat('a2', e.pubkey, 'a1'))
  const { splitThreads } = await import('./threads')
  const root = document.body.appendChild(document.createElement('div'))
  const { feed, replies } = splitThreads(g.history)
  const question = feed.find((m) => m.id === 'q')
  if (!question) throw new Error('the question should be in the main chat')
  return { e, g, root, question, replies }
}

test('the chat shows how many replies a message has and how many are new', async () => {
  const { render } = await import('preact')
  const { MessageRow } = await import('./Shell')
  const { markThreadSeen } = await import('./store')
  const { e, g, root, question, replies } = await council()
  const opened: string[] = []
  const draw = () => render(<MessageRow e={e} g={g} m={question} names={new Set()} replies={replies.get('q')} onThread={(id) => opened.push(id)} />, root)
  draw()
  expect(byId('thread-link', root).textContent).toContain('2 replies')
  expect(byId('thread-new', root).textContent).toBe('2 new')
  markThreadSeen('q', 2)
  draw()
  expect(root.querySelector('[data-testid="thread-new"]')).toBeNull()
  byId('reply-button', root).click()
  byId('thread-link', root).click()
  expect(opened).toEqual(['q', 'q'])
  render(null, root)
})

test('a reply typed in the thread panel answers the newest message from someone else', async () => {
  const { render } = await import('preact')
  const { ThreadPanel } = await import('./Shell')
  const { e, g, root, question, replies } = await council()
  let closed = false
  render(<ThreadPanel e={e} g={g} root={question} replies={replies.get('q') ?? []} names={new Set()} close={() => (closed = true)} />, root)
  await settle()
  const panel = byId('thread-panel', root)
  expect(panel.textContent).toContain('2 replies')
  // inside the panel: no reply buttons, no task toggle, and the box has the focus
  expect(panel.querySelector('[data-testid="reply-button"]')).toBeNull()
  const box = byId('thread-composer', root).querySelector('textarea')
  if (!box) throw new Error('no thread box')
  expect(box.placeholder).toBe('Reply in thread')
  expect(document.activeElement).toBe(box)
  box.value = 'thanks'
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await settle()
  const sent = g.history[g.history.length - 1]
  expect(sent?.text).toBe('thanks')
  expect(sent?.thread).toBe('a1')
  byId('thread-close', root).click()
  expect(closed).toBe(true)
  render(null, root)
})
