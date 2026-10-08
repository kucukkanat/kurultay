// Integration: the app's real engine (startEngine) and Shell in happy-dom, with a second real engine talking to it over an
// in-process relay. Pins down what the person notices: the tab title and icon, the banners, vibration, the gesture that
// unlocks audio, and the rule that a council is read only while it is open, visible and focused.
// Registered only for this file so the packages tests keep Bun's native fetch and WebSocket.
import { registerDom, unregisterDom } from './dom-env'
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'

setDefaultTimeout(20_000)
const relay = startTestRelay(0)
const bo = new Kurultay({ sk: newSecretKey(), name: 'bo', kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })

// what the page can see about the person: the tab can be hidden and the window blurred
let visibility: DocumentVisibilityState = 'visible'
let focused = true
const vibrations: (number | number[])[] = []
let oscillators = 0

/**
 * happy-dom has no Web Audio. This stands in for the browser's AudioContext so the autoplay lock is observable: it starts
 * suspended like a real one and only runs once resumed. Everything the app does with it is the real code.
 */
class LockedAudio {
  state: AudioContextState = 'suspended'
  currentTime = 0
  destination = {}
  async resume() {
    this.state = 'running'
  }
  private node = () => ({ gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, frequency: { value: 0, setValueAtTime() {} }, type: '', connect: (to: unknown) => to, start() {}, stop() {} })
  createGain = () => this.node()
  createBiquadFilter = () => this.node()
  createOscillator = () => (oscillators++, this.node())
}

beforeAll(() => {
  registerDom()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  document.hasFocus = () => focused
  Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p: number | number[]) => (vibrations.push(p), true) })
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: LockedAudio })
  document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon', href: 'data:,' }))
  localStorage.setItem('kurultay:relays', JSON.stringify([relay.url]))
})
afterAll(async () => {
  const { dismissToast, stopEngine, toasts } = await import('./store')
  const { render } = await import('preact')
  if (shell) render(null, shell)
  ;[...toasts].forEach((t) => dismissToast(t.id))
  // let the last repaint run in this window, or the store waits for a frame that never comes in the next DOM test file
  await new Promise((r) => requestAnimationFrame(r))
  await stopEngine()
  await bo.stop()
  localStorage.clear()
  await unregisterDom()
  relay.stop()
})

async function until(cond: () => unknown, ms = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
    await Bun.sleep(20)
  }
}
const frame = () => new Promise((r) => setTimeout(r, 40)) // preact's render and the store's requestAnimationFrame
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.querySelector<T>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  return el
}
let shell: HTMLElement | undefined
const root = () => (shell = document.body.appendChild(document.createElement('div')))
const icon = () => decodeURIComponent(document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ?? '')
const hasDot = () => icon().includes("cx='25'")
const banners = () => [...document.querySelectorAll<HTMLElement>('button[data-testid="toast"]')]
const set = (v: DocumentVisibilityState, f: boolean) => {
  visibility = v
  focused = f
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event(f ? 'focus' : 'blur'))
}

test('the title, icon, banners and the read rule follow what the person is looking at', async () => {
  const { createIdentity } = await import('./identity')
  const { startEngine, unreadCount } = await import('./store')
  const { Shell } = await import('./Shell')
  const { render } = await import('preact')

  const me = await startEngine(await createIdentity('amy', 'local'))
  await bo.start()
  await until(() => [...me.pool.relays, ...bo.pool.relays].every((r) => r.status === 'open'))
  const alpha = me.createGroup('alpha')
  const beta = me.createGroup('beta')
  for (const g of [alpha, beta]) await bo.redeem(me.createInvite(g.id))
  await until(() => [alpha, beta].every((g) => bo.state.groups[g.id] && me.state.groups[g.id]?.roster.members[bo.pubkey]))
  const unread = (id: string) => unreadCount(me, id).count
  const arrived = async (id: string, n: number) => {
    await until(() => me.state.groups[id]?.history.filter((m) => m.from === bo.pubkey).length === n)
    await frame()
  }

  render(<Shell />, root())
  byId(`side-${alpha.id}`).click()
  await frame()
  const base = document.title
  // the document trims its title, so with an empty base the count stands alone
  const titled = (count: string) => `${count} ${base}`.trim()
  expect(hasDot()).toBe(false)

  // autoplay: audio stays locked until the first gesture, which unlocks it
  const { audioContext } = await import('./sound')
  expect(audioContext()?.state).toBe('suspended')
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  await frame()
  expect(audioContext()?.state).toBe('running')

  // looking at alpha: what lands in beta shows in the title and icon, as a banner, and buzzes (longer when it is for me)
  await bo.send(beta.id, 'one')
  await bo.send(beta.id, 'two')
  await bo.send(beta.id, '@amy three')
  await arrived(beta.id, 3)
  expect(document.title).toBe(titled('● (3)'))
  expect(hasDot()).toBe(true)
  expect(banners().map((b) => b.textContent)).toEqual(['bo in #beta: one', 'bo in #beta: two', 'bo in #beta: @amy three'])
  expect(vibrations).toEqual([20, 20, [30, 40, 30]])
  expect(oscillators).toBeGreaterThan(0) // the gesture unlocked audio, so the first message was heard

  // my own messages never alert me
  await me.send(beta.id, 'mine')
  await until(() => me.state.groups[beta.id]?.history.some((m) => m.text === 'mine'))
  await frame()
  expect(banners()).toHaveLength(3)
  expect(vibrations).toHaveLength(3)

  // tapping a banner dismisses it and opens its council, which is then read: the title and icon clear at once
  banners()[0]?.click()
  await frame()
  expect(byId(`side-${beta.id}`).classList.contains('active')).toBe(true)
  expect(banners()).toHaveLength(2)
  expect(document.title).toBe(base)
  expect(hasDot()).toBe(false)
  expect(unread(beta.id)).toBe(0)

  // blurred, beta stays open but is not read: it counts, and still gets a banner since the tab is visible
  set('visible', false)
  await frame()
  // read marks are in whole seconds, and every render while beta was in front marked it: blurred, nothing marks it any
  // more, so wait out the second of the last mark and let the next messages land in a later one
  await Bun.sleep(1100)
  await bo.send(beta.id, 'while away')
  await arrived(beta.id, 4)
  expect(unread(beta.id)).toBe(1)
  expect(document.title).toBe(titled('(1)'))
  expect(banners()).toHaveLength(3)

  // hidden: no banner nobody would see, the title and icon carry it
  set('hidden', false)
  await bo.send(beta.id, 'still away')
  await arrived(beta.id, 5)
  expect(unread(beta.id)).toBe(2)
  expect(document.title).toBe(titled('(2)'))
  expect(hasDot()).toBe(true)
  expect(banners()).toHaveLength(3)

  // coming back is what reads it
  set('visible', true)
  await frame()
  await frame()
  expect(unread(beta.id)).toBe(0)
  expect(document.title).toBe(base)
  expect(hasDot()).toBe(false)

  // opening a council from the sidebar clears its count right away, without waiting for something else to repaint
  await bo.send(alpha.id, 'over here')
  await arrived(alpha.id, 1)
  expect(document.title).toBe(titled('(1)'))
  byId(`side-${alpha.id}`).click()
  await frame()
  expect(document.title).toBe(base)
  expect(hasDot()).toBe(false)
})
