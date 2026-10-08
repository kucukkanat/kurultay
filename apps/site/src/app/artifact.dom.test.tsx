// Integration: an artifact block rendered into happy-dom and run, to pin down the frame's sandbox and what it may tell the page.
// Registered only for this file so the packages tests keep Bun's native fetch and WebSocket.
import { registerDom, unregisterDom } from './dom-env'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'

beforeAll(() => registerDom())
afterAll(() => unregisterDom())
afterEach(async () => (await import('preact')).render(null, document.body))

const settle = () => new Promise((r) => setTimeout(r, 20))
const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.querySelector<T>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  return el
}

async function run(): Promise<HTMLIFrameElement> {
  const { render } = await import('preact')
  const { Markdown } = await import('./markdown')
  const { richBlocks } = await import('./richblocks')
  render(<Markdown text={'```artifact\n<title>Counter</title><p>hi</p>\n```'} names={new Set()} blocks={richBlocks} />, document.body)
  byId('artifact-run').click()
  await settle()
  return byId<HTMLIFrameElement>('artifact-frame')
}

test('the frame is sandboxed to scripts only, with the policy ahead of the author', async () => {
  const frame = await run()
  // allow-same-origin here would hand the page's keys to any artifact
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('srcdoc') ?? '').toStartWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'')
  expect(frame.getAttribute('srcdoc')).toContain('<p>hi</p>')
})

test('only the frame itself can set its height', async () => {
  const frame = await run()
  const height = () => frame.style.height
  const before = height()
  dispatchEvent(new MessageEvent('message', { data: { kurultay: 'height', h: 400 }, source: window }))
  await settle()
  expect(height()).toBe(before)
  dispatchEvent(new MessageEvent('message', { data: { kurultay: 'height', h: 400 }, source: frame.contentWindow }))
  await settle()
  expect(height()).toBe('400px')
})

test('a frame that navigates away is removed with a warning', async () => {
  const frame = await run()
  // happy-dom has loaded the srcdoc by now (the first load), and the frame is still there
  expect(document.querySelector('[data-testid="artifact-left"]')).toBeNull()
  frame.dispatchEvent(new Event('load'))
  await settle()
  expect(document.querySelector('[data-testid="artifact-frame"]')).toBeNull()
  byId('artifact-left')
})
