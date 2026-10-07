// Integration: the drawer swipe hook and the dialog rendered into happy-dom at phone width, driven by real touch and mouse
// events. Registered only for this file so the packages tests keep Bun's native fetch and WebSocket.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { PHONE_MAX } from '../shared/theme'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost:5173/app/', width: 375, height: 800 }))
afterAll(() => GlobalRegistrator.unregister())

// effects (where the hook adds its listeners) run after the frame, so give preact a beat after every render and event
const settle = () => new Promise((r) => setTimeout(r, 30))
const byId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  return el
}

/** A finger from (x0, y0) to (x1, y1): touchstart then touchend, bubbling up to the window listeners. */
async function swipe(x0: number, y0: number, x1: number, y1: number) {
  const at = (x: number, y: number) => new Touch({ identifier: 1, target: document.body, clientX: x, clientY: y })
  document.body.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [at(x0, y0)], changedTouches: [at(x0, y0)] }))
  document.body.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [at(x1, y1)] }))
  await settle()
}

async function drawer() {
  const { render } = await import('preact')
  const { useState } = await import('preact/hooks')
  const { useDrawerSwipe } = await import('./gestures')
  function Nav() {
    const [open, setOpen] = useState(false)
    useDrawerSwipe(open, setOpen)
    return <aside data-testid="sidebar" data-open={open} />
  }
  const root = document.body.appendChild(document.createElement('div'))
  render(<Nav />, root)
  await settle()
  return { open: () => byId('sidebar').dataset.open, unmount: () => render(null, root) }
}

test('on a phone, a swipe from the left edge opens the drawer and a swipe left closes it', async () => {
  expect(innerWidth).toBeLessThanOrEqual(PHONE_MAX)
  const d = await drawer()
  await swipe(100, 300, 250, 310)
  expect(d.open()).toBe('false')
  await swipe(10, 300, 40, 300)
  expect(d.open()).toBe('false')
  await swipe(10, 300, 200, 300)
  expect(d.open()).toBe('true')
  await swipe(250, 300, 260, 600)
  expect(d.open()).toBe('true')
  await swipe(250, 300, 100, 320)
  expect(d.open()).toBe('false')
  d.unmount()
})

test('on a wide screen the same swipe does nothing', async () => {
  const viewport = (width: number) => (window as unknown as { happyDOM: { setViewport(v: { width: number }): void } }).happyDOM.setViewport({ width })
  viewport(1024)
  const d = await drawer()
  await swipe(10, 300, 200, 300)
  expect(d.open()).toBe('false')
  d.unmount()
  viewport(375)
})

test('a dialog closes from its backdrop or close button, not from inside', async () => {
  const { render } = await import('preact')
  const { Modal } = await import('./ui')
  let closed = 0
  const root = document.body.appendChild(document.createElement('div'))
  render(
    <Modal title="Invite" onClose={() => closed++}>
      <p>body</p>
    </Modal>,
    root,
  )
  const down = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  down(byId('modal'))
  expect(closed).toBe(0)
  down(byId('modal-backdrop'))
  expect(closed).toBe(1)
  byId('modal-close').click()
  expect(closed).toBe(2)
  render(null, root)
})
