// Integration: real DOM events through happy-dom, registered only for this file so the packages tests keep Bun's
// native fetch and WebSocket.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost:5173/app/' }))
afterAll(() => GlobalRegistrator.unregister())

type Mods = Readonly<{ ctrlKey?: boolean; metaKey?: boolean }>
const type = (target: EventTarget, text: string, mods: Mods = {}) => {
  for (const key of text) target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, ...mods }))
}

/** Count how often the word fires while `act` runs, then clean up the listener. */
const hitsDuring = async (act: () => void): Promise<number> => {
  const { watchWord } = await import('./devmode')
  let hits = 0
  const stop = watchWord(() => hits++)
  act()
  stop()
  return hits
}

const mount = <K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] => document.body.appendChild(document.createElement(tag))

describe('watchWord', () => {
  test('fires once when typed on the page', async () => expect(await hitsDuring(() => type(document.body, 'kurultaydev'))).toBe(1))
  test('ignores text fields', async () => {
    const editable = mount('div')
    editable.contentEditable = 'true'
    const fields: readonly HTMLElement[] = [mount('input'), mount('textarea'), mount('select'), editable]
    expect(await hitsDuring(() => fields.forEach((f) => type(f, 'kurultaydev')))).toBe(0)
  })
  test('ignores shortcuts', async () => {
    expect(await hitsDuring(() => type(document.body, 'kurultaydev', { ctrlKey: true }))).toBe(0)
    expect(await hitsDuring(() => type(document.body, 'kurultaydev', { metaKey: true }))).toBe(0)
  })
  test('ignores fields inside a shadow root', async () => {
    const root = mount('div').attachShadow({ mode: 'open' })
    const input = root.appendChild(document.createElement('input'))
    expect(await hitsDuring(() => type(input, 'kurultaydev'))).toBe(0)
  })
  test('stops after cleanup', async () => {
    const { watchWord } = await import('./devmode')
    let hits = 0
    watchWord(() => hits++)()
    type(document.body, 'kurultaydev')
    expect(hits).toBe(0)
  })
  test('toggles the stored developer mode end to end', async () => {
    const { watchWord } = await import('./devmode')
    // store reads location and localStorage at import, so it loads only once the DOM is registered
    const { devMode, setDevMode } = await import('./store')
    localStorage.removeItem('kurultay:dev')
    const stop = watchWord(() => setDevMode(!devMode()))
    type(document.body, 'kurultaydev')
    expect(localStorage.getItem('kurultay:dev')).toBe('1')
    type(document.body, 'kurultaydev')
    expect(localStorage.getItem('kurultay:dev')).toBe('0')
    stop()
  })
})
