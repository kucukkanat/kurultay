// Integration: the board panel rendered into happy-dom around a real (offline) engine. Registered only for this file so
// the packages tests keep Bun's native fetch and WebSocket.
import { registerDom, unregisterDom } from './dom-env'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'

const relay = startTestRelay(0)
const engines: Kurultay[] = []
beforeAll(() => registerDom({ url: 'http://localhost:5173/kurultay/app/' }))
afterAll(async () => {
  engines.forEach((e) => e.pool.close())
  await unregisterDom()
  relay.stop()
})

const byId = (id: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  return el
}

test('the board panel says it is encrypted, opens loading, and its buttons expand and close it', async () => {
  const { render } = await import('preact')
  const { BoardPanel } = await import('./BoardPanel')
  const e = new Kurultay({ sk: newSecretKey(), name: 'amy', kind: 'human', relays: [relay.url], storage: new MemoryStorage() })
  engines.push(e)
  const g = e.createGroup('ops')
  // creating the council subscribes on the local relay: let that connection settle before the test tears it down
  for (let i = 0; i < 100 && !e.pool.relays.every((r) => r.status === 'open'); i++) await new Promise((r) => setTimeout(r, 20))
  const root = document.body.appendChild(document.createElement('div'))
  const calls: string[] = []
  const draw = (full: boolean) => render(<BoardPanel e={e} g={g} full={full} toggleFull={() => calls.push('full')} close={() => calls.push('close')} />, root)
  draw(false)
  expect(byId('board-encrypted', root).textContent).toContain('Encrypted for this council')
  expect(byId('board-loading', root)).toBeTruthy()
  expect(byId('board-canvas', root)).toBeTruthy()
  expect(byId('board-panel', root).classList.contains('full')).toBe(false)
  byId('board-expand', root).click()
  byId('board-close', root).click()
  expect(calls).toEqual(['full', 'close'])
  draw(true)
  expect(byId('board-panel', root).classList.contains('full')).toBe(true)
  expect(byId('board-expand', root).getAttribute('aria-pressed')).toBe('true')
  // Bun cannot resolve Excalidraw's stylesheet export (it only has development/production conditions), so here the lazy
  // load fails: the panel must say so instead of spinning forever. In the browser Vite resolves it and the board mounts.
  for (let i = 0; i < 100 && root.querySelector('[data-testid="board-loading"]'); i++) await new Promise((r) => setTimeout(r, 50))
  expect(byId('board-failed', root).textContent).toContain('could not load')
  render(null, root)
})

test('Esc leaves a full-screen board, but not while writing text on it', async () => {
  const { escLeavesFullBoard } = await import('./BoardPanel')
  const host = document.body.appendChild(document.createElement('div'))
  host.className = 'excalidraw'
  const textarea = host.appendChild(document.createElement('textarea'))
  expect(escLeavesFullBoard({ key: 'Escape', target: document.body })).toBe(true)
  expect(escLeavesFullBoard({ key: 'Escape', target: textarea })).toBe(false)
  expect(escLeavesFullBoard({ key: 'Enter', target: document.body })).toBe(false)
  host.remove()
})
