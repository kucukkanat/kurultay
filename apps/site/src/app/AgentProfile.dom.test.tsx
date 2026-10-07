// Integration: the profile editor rendered into happy-dom, driving a real (offline) engine. Registered only for this
// file so the packages tests keep Bun's native fetch and WebSocket.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost:5173/app/' }))
afterAll(() => GlobalRegistrator.unregister())

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.querySelector<T>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  return el
}
const settle = () => new Promise((r) => setTimeout(r, 30))
const typeInto = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/** An owner whose agents exist (minted by a ticket) but never went online: profile edits are stored and queued. */
async function mountEditor() {
  const { render } = await import('preact')
  const { AgentProfileEditor } = await import('./AgentProfile')
  const owner = new Kurultay({ sk: newSecretKey(), name: 'owner', kind: 'human', relays: [], storage: new MemoryStorage() })
  owner.createTicket([], { hosts: ['claude'] })
  const pubkey = Object.keys(owner.state.agents)[0] ?? ''
  const root = document.body.appendChild(document.createElement('div'))
  render(<AgentProfileEditor e={owner} pubkey={pubkey} current="claude" />, root)
  return { owner, pubkey, root, rerender: () => render(<AgentProfileEditor e={owner} pubkey={pubkey} current="claude" />, root) }
}

test('the owner edits name, picture and instructions and saves them together', async () => {
  const { owner, pubkey, root } = await mountEditor()
  byId('agent-profile-edit').click()
  await settle()
  expect(byId('avatar-picker').querySelector('img')?.getAttribute('src')).toStartWith('data:image/svg+xml')
  expect(document.querySelector('[data-testid="avatar-reset"]')).toBeNull()
  typeInto(byId<HTMLInputElement>('agent-name-input'), 'reviewer')
  typeInto(byId<HTMLTextAreaElement>('agent-instructions'), '  Review PRs. Security first.  ')
  await settle()
  expect(byId('agent-profile-form').textContent).toContain('@mention it as reviewer')
  byId<HTMLButtonElement>('agent-profile-save').click()
  await settle()
  expect(owner.state.agentNames?.[pubkey]).toBe('reviewer')
  expect(owner.state.agentInstructions?.[pubkey]).toBe('Review PRs. Security first.')
  expect(owner.state.agentAvatars?.[pubkey]).toBeUndefined()
  // the form closed and says the agent picks it up next time it is online
  expect(document.querySelector('[data-testid="agent-profile-form"]')).toBeNull()
  expect(root.textContent).toContain('applies when it’s next online')
  root.remove()
})

test('a stored picture shows in the editor and "Use the default" clears it on save', async () => {
  const { owner, pubkey, root, rerender } = await mountEditor()
  await owner.setAgentProfile(pubkey, { avatar: PNG })
  rerender()
  byId('agent-profile-edit').click()
  await settle()
  expect(byId('avatar-picker').querySelector('img')?.getAttribute('src')).toBe(PNG)
  byId('avatar-reset').click()
  await settle()
  expect(byId('avatar-picker').querySelector('img')?.getAttribute('src')).toStartWith('data:image/svg+xml')
  byId('agent-profile-save').click()
  await settle()
  expect(owner.state.agentAvatars?.[pubkey]).toBeUndefined()
  root.remove()
})

test('picking a file that is not an image shows the error inline and keeps the picture', async () => {
  const { root } = await mountEditor()
  byId('agent-profile-edit').click()
  await settle()
  const input = byId<HTMLInputElement>('avatar-file')
  // what the browser does when someone picks a file: fills `files`, then fires change
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['hi'], 'notes.txt', { type: 'text/plain' })] })
  input.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
  expect(byId('avatar-error').textContent).toBe('Choose an image file')
  expect(byId('avatar-picker').querySelector('img')?.getAttribute('src')).toStartWith('data:image/svg+xml')
  byId('agent-profile-cancel').click()
  await settle()
  expect(document.querySelector('[data-testid="agent-profile-form"]')).toBeNull()
  root.remove()
})

test('an invalid name keeps Save disabled', async () => {
  const { root } = await mountEditor()
  byId('agent-profile-edit').click()
  await settle()
  typeInto(byId<HTMLInputElement>('agent-name-input'), '!!!')
  await settle()
  expect(byId<HTMLButtonElement>('agent-profile-save').disabled).toBe(true)
  expect(byId('agent-profile-form').textContent).toContain('Letters, digits and _ # . - only')
  root.remove()
})
