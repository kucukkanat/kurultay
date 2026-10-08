// Integration: the page's daemon client, in happy-dom (so requests carry the app's Origin), against a real
// `kurultay daemon` and real `kurultay pair` subprocesses. Registered only for this file so other tests keep Bun's fetch.
import { registerDom, unregisterDom } from './dom-env'
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

setDefaultTimeout(30_000)
const cli = join(import.meta.dir, '../../../../packages/mcp/src/cli.ts')
const home = realpathSync(mkdtempSync(join(tmpdir(), 'kurultay-client-')))
const kHome = join(home, '.config/kurultay')
// no relay is needed: nothing is seated, the page only pairs and reads state
const env = { ...process.env, HOME: home, KURULTAY_HOME: kHome, KURULTAY_NO_KEYCHAIN: '1', KURULTAY_RELAYS: 'ws://127.0.0.1:1', KURULTAY_PORT: '0' }
let daemon: ReturnType<typeof Bun.spawn> | undefined
let port = ''

const until = async (cond: () => unknown, ms = 10_000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await Bun.sleep(50)
  }
}

beforeAll(async () => {
  mkdirSync(join(home, 'project'), { recursive: true })
  daemon = Bun.spawn(['bun', cli, 'daemon'], { env, cwd: home, stdout: 'ignore', stderr: 'inherit' })
  await until(() => existsSync(join(kHome, 'daemon.port')))
  port = readFileSync(join(kHome, 'daemon.port'), 'utf8').trim()
  registerDom()
})
afterAll(async () => {
  daemon?.kill()
  // this test's toasts expire on a timer that dies with this window: let them expire here, not linger into the next file
  const { toasts } = await import('./store')
  await until(() => !toasts.some((t) => t.text.startsWith('Agents ')), 8000)
  await unregisterDom()
})

const byId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = (id: string) => {
  const el = byId(id)
  if (!el) throw new Error(`no [data-testid="${id}"] on the page`)
  el.click()
}

test('the page finds the service, pairs through the terminal, controls it and unpairs', async () => {
  localStorage.setItem('kurultay:daemon-port', port)
  const c = await import('./daemon-client')
  const { render, h } = await import('preact')
  const { DaemonSection, FolderPicker } = await import('./DaemonPanel')
  const root = document.body.appendChild(document.createElement('div'))
  render(h(DaemonSection, {}), root)
  const stop = c.watchDaemon()
  try {
    await until(() => byId('daemon-unpaired'))
    expect(c.daemonState().health).toMatchObject({ app: 'kurultay', paired: false })

    click('pair-start')
    await until(() => byId('pair-code'))
    const code = byId('pair-code')?.textContent ?? ''
    expect(code).toMatch(/^\d{6}$/)
    expect(code).toBe(c.daemonState().pairing?.code ?? '')
    const approve = Bun.spawn(['bun', cli, 'pair', code], { env, stdout: 'ignore', stderr: 'inherit' })
    expect(await approve.exited).toBe(0)
    await until(() => byId('daemon-connected'))
    expect(c.daemonState().snapshot).toMatchObject({ paused: false, agents: [], home: kHome })
    expect(localStorage.getItem('kurultay:daemon-token')).toMatch(/^[0-9a-f]{64}$/)

    // stop and start the agents from the page
    click('daemon-pause')
    await until(() => byId('daemon-resume'))
    expect(c.daemonState().snapshot?.paused).toBe(true)
    click('daemon-resume')
    await until(() => byId('daemon-pause'))

    // the folder picker browses the service's computer, not the browser's
    let picked = ''
    const pickerRoot = document.body.appendChild(document.createElement('div'))
    render(h(FolderPicker, { value: home, onChange: (p: string) => (picked = p) }), pickerRoot)
    click('folder-browse')
    await until(() => byId('browse-dir-project'))
    click('browse-dir-project')
    await until(() => byId('browse-path')?.textContent === join(home, 'project'))
    click('browse-use')
    expect(picked).toBe(join(home, 'project'))
    render(null, pickerRoot)

    // revoked from the terminal: the next look notices the 401 and asks to pair again
    const revoke = Bun.spawn(['bun', cli, 'pair', '--revoke'], { env, stdout: 'ignore', stderr: 'inherit' })
    expect(await revoke.exited).toBe(0)
    await c.refresh()
    expect(c.daemonState().status).toBe('unpaired')
    expect(localStorage.getItem('kurultay:daemon-token')).toBeNull()
    await until(() => byId('daemon-unpaired'))
  } finally {
    stop()
    render(null, root)
  }
})
