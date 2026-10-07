// Integration: the settings section rendered into happy-dom, writing to this browser's real storage. Registered only for
// this file so the packages tests keep Bun's native fetch and WebSocket.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost:5173/app/' }))
afterAll(async () => {
  localStorage.clear()
  await GlobalRegistrator.unregister()
})

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.querySelector<T>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  return el
}
const settle = () => new Promise((r) => setTimeout(r, 40))
const stored = () => JSON.parse(localStorage.getItem('kurultay:prefs') || 'null')

test('switches and the scope are saved per browser, validated, and sound off disables its options', async () => {
  localStorage.setItem('kurultay:prefs', '{"volume": 9, "scope": "everyone"}')
  const { render } = await import('preact')
  const { NotificationSettings } = await import('./NotificationSettings')
  render(<NotificationSettings />, document.body.appendChild(document.createElement('div')))

  for (const id of ['pref-sound', 'pref-volume', 'pref-scope', 'pref-soundWhenOpen', 'pref-vibrate', 'pref-banners', 'pref-titleBadge', 'test-message-sound', 'test-mention-sound']) byId(id)
  expect(byId<HTMLInputElement>('pref-volume').value).toBe('100') // the stored 9 was clamped
  expect(byId<HTMLSelectElement>('pref-scope').value).toBe('all') // the unknown scope fell back

  const scope = byId<HTMLSelectElement>('pref-scope')
  scope.value = 'direct'
  scope.dispatchEvent(new Event('change', { bubbles: true }))
  byId<HTMLInputElement>('pref-banners').click()
  await settle()
  expect(stored()).toMatchObject({ scope: 'direct', banners: false, volume: 1 })

  byId<HTMLInputElement>('pref-sound').click()
  await settle()
  expect(stored().sound).toBe(false)
  expect(byId<HTMLInputElement>('pref-vibrate').disabled).toBe(true)
  expect(byId<HTMLButtonElement>('test-message-sound').disabled).toBe(true)
  expect(byId<HTMLInputElement>('pref-banners').disabled).toBe(false)
})
