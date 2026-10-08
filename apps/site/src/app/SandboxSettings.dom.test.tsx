// Integration: an agent's sandbox panel rendered into happy-dom, talking to a real `kurultay daemon` this browser never
// paired with: a change the panel sends is refused for real and must show up next to the switch (never silently).
// Registered only for this file so the packages tests keep Bun's native fetch.
import { registerDom, unregisterDom } from './dom-env'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DaemonAgentInfo } from '@kurultay/core'

const cli = join(import.meta.dir, '../../../../packages/mcp/src/cli.ts')
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kurultay-sbx-ui-')))
const kHome = join(home, '.config/kurultay')
let daemon: ReturnType<typeof Bun.spawn> | undefined

beforeAll(async () => {
  const env = { ...process.env, HOME: home, KURULTAY_HOME: kHome, KURULTAY_NO_KEYCHAIN: '1', KURULTAY_RELAYS: 'ws://127.0.0.1:1', KURULTAY_PORT: '0' }
  daemon = Bun.spawn(['bun', cli, 'daemon'], { env, cwd: home, stdout: 'ignore', stderr: 'inherit' })
  for (let i = 0; i < 200 && !existsSync(join(kHome, 'daemon.port')); i++) await Bun.sleep(50)
  registerDom()
  localStorage.setItem('kurultay:daemon-port', readFileSync(join(kHome, 'daemon.port'), 'utf8').trim())
})
afterAll(async () => {
  daemon?.kill()
  localStorage.clear()
  await unregisterDom()
})

const agent = (sandbox: DaemonAgentInfo['sandbox']): DaemonAgentInfo => ({ instance: 'codex#1', pubkey: 'ab', name: 'brisk-otter', host: 'codex', workdir: '/w', mode: 'edit', online: true, running: false, councils: [], groupIds: [], sandbox })
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}-codex#1"]`)
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms))

async function mount(a: DaemonAgentInfo) {
  const { render } = await import('preact')
  const { SandboxSettings } = await import('./SandboxSettings')
  const root = document.body.appendChild(document.createElement('div'))
  render(<SandboxSettings local={a} />, root)
  return root
}

test('an agent seated without a sandbox shows the switch off, and no badge, blocked list or settings', async () => {
  const root = await mount(agent(undefined))
  expect(q('agent-sandbox-toggle')).toHaveProperty('checked', false)
  for (const id of ['agent-sandbox-badge', 'agent-sandbox-blocked', 'agent-sandbox-settings', 'agent-sandbox-fellback']) expect(q(id)).toBeNull()
  root.remove()
})

test('a sandboxed agent shows its badge, the fallback warning and what was blocked, with Allow only for websites', async () => {
  const root = await mount(
    agent({
      enabled: true,
      allowDomains: ['docs.example.com'],
      readPaths: [],
      writePaths: [],
      fellBack: 'missing bwrap',
      lastViolations: [
        { kind: 'network', target: 'api.example.com', at: 3 },
        { kind: 'network', target: 'docs.example.com', at: 2 },
        { kind: 'read', target: '/Users/me/.ssh/id_ed25519', at: 1 },
      ],
    }),
  )
  expect(q('agent-sandbox-badge')?.textContent).toBe('Sandboxed')
  expect(q('agent-sandbox-fellback')?.textContent).toContain('missing bwrap')
  expect(q('agent-sandbox-allow-0')).not.toBeNull()
  // already allowed: says so instead of offering the button again
  expect(q('agent-sandbox-allow-1')).toBeNull()
  expect(q('agent-sandbox-blocked-1')?.textContent).toContain('Allowed')
  // a file is opened on purpose in the settings, never with one click
  expect(q('agent-sandbox-allow-2')).toBeNull()
  expect(q('agent-sandbox-domains')).toHaveProperty('value', 'docs.example.com')
  root.remove()
})

test('turning it off asks first (D25); confirming sends it, and a failure is shown next to the switch', async () => {
  const root = await mount(agent({ enabled: true, allowDomains: [], readPaths: [], writePaths: [], lastViolations: [] }))
  q('agent-sandbox-toggle')?.click()
  await settle()
  expect(q('agent-sandbox-off-ask')?.textContent).toContain('read your whole home folder')
  q('agent-sandbox-off-cancel')?.click()
  await settle()
  expect(q('agent-sandbox-off-ask')).toBeNull()
  q('agent-sandbox-toggle')?.click()
  await settle()
  q('agent-sandbox-off-confirm')?.click()
  for (let i = 0; i < 100 && !q('agent-sandbox-error'); i++) await settle(50)
  expect(q('agent-sandbox-error')?.textContent).toBe('not paired')
  expect(q('agent-sandbox-toggle')).toHaveProperty('checked', true)
  root.remove()
})
