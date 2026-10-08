// Integration: a real engine saving through BrowserStorage into happy-dom's localStorage. A busy board must never stop
// the state (keys, councils) from being saved, and a failure to save must be said out loud.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { buildElements, getPublicKey, Kurultay, newSecretKey, type BoardElement } from '@kurultay/core'
import { startTestRelay, type TestRelay } from '@kurultay/core/testing'
import { BOARD_STORE_CHARS, BrowserStorage } from './identity'

let relay: TestRelay
const engines: Kurultay[] = []
beforeAll(() => {
  // the engine talks to the relay over Bun's own WebSocket; happy-dom only lends its localStorage
  const ws = globalThis.WebSocket
  GlobalRegistrator.register({ url: 'http://localhost:5173/app/' })
  globalThis.WebSocket = ws
  relay = startTestRelay(0)
})
afterAll(async () => {
  await Promise.all(engines.map((e) => e.stop()))
  relay.stop()
  await GlobalRegistrator.unregister()
})

const until = async (cond: () => unknown, ms = 8000) => {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await Bun.sleep(20)
  }
}

async function engine(sk: Uint8Array, storage: BrowserStorage) {
  const e = new Kurultay({ sk, name: 'me', kind: 'human', relays: [relay.url], storage, presenceInterval: 3_600_000 })
  engines.push(e)
  await e.start()
  return e
}

const aesKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

test('a board is kept apart from the state, encrypted, and comes back after a reload', async () => {
  const sk = newSecretKey()
  const aes = await aesKey()
  const pk = getPublicKey(sk)
  const first = await engine(sk, new BrowserStorage(pk, aes))
  const g = first.createGroup('sketches')
  await first.drawBoard(g.id, buildElements([{ kind: 'rectangle', x: 0, y: 0, label: 'kept-on-device' }]))
  first.flush()
  await until(() => localStorage.getItem(`kurultay:board:${pk}:${g.id}`))
  const stateRaw = localStorage.getItem(`kurultay:state:${pk}`) ?? ''
  const boardRaw = localStorage.getItem(`kurultay:board:${pk}:${g.id}`) ?? ''
  expect(stateRaw).not.toContain('kept-on-device')
  expect(boardRaw).not.toContain('kept-on-device')
  const saved = await new BrowserStorage(pk, aes).load()
  expect(saved?.groups[g.id]?.board).toBeUndefined()
  await first.stop()
  const again = await engine(sk, new BrowserStorage(pk, aes))
  expect(Object.values(again.boardScene(g.id)).some((e) => e.text === 'kept-on-device')).toBe(true)
})

test('a board too big for this device is not kept, says so, and never blocks saving the councils', async () => {
  const sk = newSecretKey()
  const pk = getPublicKey(sk)
  const e = await engine(sk, new BrowserStorage(pk, null))
  const notices: { level: string; text: string }[] = []
  e.on('notice', (n) => notices.push(n))
  const g = e.createGroup('busy')
  // about 22 KB a stroke, under the per-element limit: 100 of them are more than the boards' share of localStorage
  const [base] = buildElements([{ kind: 'rectangle', x: 0, y: 0 }])
  if (!base) throw new Error('setup')
  const strokes: BoardElement[] = Array.from({ length: 100 }, (_, n) => ({ ...base, id: `stroke${n}`, type: 'freedraw', points: Array.from({ length: 700 }, (_, i) => [i + 0.123456789, i + 0.987654321]) }))
  expect(JSON.stringify(strokes).length).toBeGreaterThan(BOARD_STORE_CHARS)
  await e.drawBoard(g.id, strokes)
  e.flush()
  await until(() => notices.some((n) => n.text.includes('busy')))
  expect(notices.filter((n) => n.text.includes('board'))).toHaveLength(1)
  expect(localStorage.getItem(`kurultay:board:${pk}:${g.id}`)).toBeNull()
  // the council itself (and its key) is saved
  const saved = await new BrowserStorage(pk, null).load()
  expect(saved?.groups[g.id]?.key).toBe(e.state.groups[g.id]?.key)
  // saving again does not repeat the notice
  e.flush()
  await Bun.sleep(100)
  expect(notices.filter((n) => n.text.includes('board'))).toHaveLength(1)
}, 20_000)
