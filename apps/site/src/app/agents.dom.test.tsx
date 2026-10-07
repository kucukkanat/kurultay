// Integration: seating and managing agents from the page, in happy-dom, against a real `kurultay daemon`, a real relay
// and a real owner engine. The page pairs through a real `kurultay pair`. Registered only for this file so the other
// tests keep Bun's fetch; the owner engine keeps Bun's WebSocket, since happy-dom's is not a relay client.
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'
import { startTestRelay } from '@kurultay/core/testing'

setDefaultTimeout(60_000)
const relay = startTestRelay(0)
const cli = join(import.meta.dir, '../../../../packages/mcp/src/cli.ts')
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kurultay-agents-ui-')))
const kHome = join(home, '.config/kurultay')
const bin = join(home, 'bin')
const work = join(home, 'project')
const other = join(home, 'other')
for (const d of [bin, work, other, join(home, '.codex')]) mkdirSync(d)
// seating asks the CLI whether a Kurultay plugin is installed; a stand-in keeps the test off any real Codex
writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n')
chmodSync(join(bin, 'codex'), 0o755)
const env = { ...process.env, HOME: home, KURULTAY_HOME: kHome, KURULTAY_NO_KEYCHAIN: '1', KURULTAY_RELAYS: relay.url, KURULTAY_MACHINE: 'testbox', KURULTAY_PORT: '0', PATH: `${bin}:${process.env.PATH}` }
let daemon: ReturnType<typeof Bun.spawn> | undefined
let owner: Kurultay | undefined
const registry = (): Record<string, { workdir: string }> => JSON.parse(readFileSync(join(kHome, 'agents.json'), 'utf8'))

const until = async (cond: () => unknown, ms = 15_000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await Bun.sleep(50)
  }
}

beforeAll(async () => {
  daemon = Bun.spawn(['bun', cli, 'daemon'], { env, cwd: home, stdout: 'ignore', stderr: 'inherit' })
  await until(() => existsSync(join(kHome, 'daemon.port')))
  const NativeWebSocket = globalThis.WebSocket
  GlobalRegistrator.register({ url: 'http://localhost:5173/app/' })
  globalThis.WebSocket = NativeWebSocket
  localStorage.setItem('kurultay:daemon-port', readFileSync(join(kHome, 'daemon.port'), 'utf8').trim())
  owner = new Kurultay({ sk: newSecretKey(), name: 'tolga', kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
  await owner.start()
})
afterAll(async () => {
  daemon?.kill()
  await owner?.stop()
  relay.stop()
  // toasts expire on a timer and repaint through requestAnimationFrame: let that happen while this window exists
  const { toasts } = await import('./store')
  await until(() => !toasts.length, 8000).catch(() => {})
  await new Promise((r) => requestAnimationFrame(r))
  localStorage.clear()
  await GlobalRegistrator.unregister()
})

const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.querySelector<T>(`[data-testid="${id}"]`)
const click = (id: string) => {
  const el = byId(id)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  el.click()
}
const typeInto = (id: string, value: string) => {
  const el = byId<HTMLInputElement>(id)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

test('pairing, seating from the dialog, then moving, stopping and removing the agent from its card', async () => {
  const e = owner
  if (!e) throw new Error('owner engine did not start')
  const c = await import('./daemon-client')
  const { render, h } = await import('preact')
  const { AddAgentDialog, AgentsList } = await import('./agents')
  const { DaemonSection } = await import('./DaemonPanel')
  const g = e.createGroup('ops')
  const stop = c.watchDaemon()
  try {
    // the pairing card: a code to approve, which can be called off, and is then approved in a terminal
    const card = document.body.appendChild(document.createElement('div'))
    render(h(DaemonSection, {}), card)
    await until(() => byId('daemon-unpaired'))
    click('pair-start')
    await until(() => byId('pair-code'))
    click('pair-cancel')
    await until(() => byId('daemon-unpaired'))
    click('pair-start')
    await until(() => byId('pair-code'))
    const approve = Bun.spawn(['bun', cli, 'pair', byId('pair-code')?.textContent ?? ''], { env, stdout: 'ignore', stderr: 'inherit' })
    expect(await approve.exited).toBe(0)
    await until(() => byId('daemon-connected'))

    // paired: Add your agents is a form, not a command
    const dialog = document.body.appendChild(document.createElement('div'))
    const showDialog = () => render(h(AddAgentDialog, { e, groupId: g.id, onClose: () => render(null, dialog) }), dialog)
    showDialog()
    await until(() => byId('seat-submit'))
    expect(byId<HTMLInputElement>('seat-host-codex')?.checked).toBe(true)
    expect(byId<HTMLInputElement>(`seat-council-${g.id}`)?.checked).toBe(true)
    expect(byId<HTMLInputElement>('seat-sandbox')?.checked).toBe(true)
    typeInto('seat-folder-input', work)
    await until(() => !byId<HTMLButtonElement>('seat-submit')?.disabled)
    click('seat-submit')
    await until(() => (showDialog(), byId('seat-progress')?.textContent?.includes('joined #ops')), 30_000)
    expect(registry()['codex#1']).toMatchObject({ workdir: work, sandbox: { enabled: true } })
    expect(byId('seat-close')?.textContent).toBe('Done')
    click('seat-close')
    expect(byId('seat-submit')).toBeNull()

    // its card under My agents gets the controls for this computer
    const list = document.body.appendChild(document.createElement('div'))
    const showList = () => render(h(AgentsList, { e }), list)
    await until(() => (showList(), byId('agent-local-codex#1')))

    // browse into a folder and back up, then save it as the agent's folder
    click('agent-folder-codex#1-browse')
    await until(() => byId('browse-path')?.textContent === work)
    click('browse-up')
    await until(() => byId('browse-path')?.textContent === home)
    click('browse-dir-other')
    await until(() => byId('browse-path')?.textContent === other)
    click('browse-use')
    await until(() => byId<HTMLInputElement>('agent-folder-codex#1-input')?.value === other)
    click('agent-folder-save-codex#1')
    await until(() => registry()['codex#1']?.workdir === other)

    // stopped agents keep their card controls, so a folder can still be changed while they are off
    click('daemon-pause')
    await until(() => (showList(), c.daemonState().snapshot?.paused && byId('agent-local-codex#1')))
    expect(byId('daemon-resume')).not.toBeNull()
    click('daemon-resume')
    await until(() => c.daemonState().snapshot?.agents[0]?.online)

    // removing asks first; Keep calls it off
    click('agent-remove-codex#1')
    await until(() => byId('agent-remove-cancel-codex#1'))
    expect(byId('agent-local-codex#1')?.textContent).toContain('its key is deleted')
    click('agent-remove-cancel-codex#1')
    await until(() => byId('agent-remove-codex#1'))
    expect(registry()['codex#1']).toBeDefined()
    click('agent-remove-codex#1')
    await until(() => byId('agent-remove-confirm-codex#1'))
    click('agent-remove-confirm-codex#1')
    await until(() => !registry()['codex#1'], 20_000)
    await until(() => (showList(), !byId('agent-local-codex#1')))
    render(null, list)
    render(null, card)
  } finally {
    stop()
  }
})
