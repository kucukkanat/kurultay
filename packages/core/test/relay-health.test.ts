import { afterAll, describe, expect, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey, noteRelay, relayHealth, type FailedRelays } from '../src'
import { startTestRelay, type TestRelay } from '../src/testing/relay'

const A = 'wss://a.example'
const B = 'wss://b.example'

describe('noteRelay', () => {
  const empty: FailedRelays = new Set()
  test('closed and error mark a relay failed; open clears it', () => {
    const closed = noteRelay(empty, { url: A, status: 'closed' })
    expect([...closed]).toEqual([A])
    expect([...noteRelay(empty, { url: A, status: 'error' })]).toEqual([A])
    expect([...noteRelay(closed, { url: A, status: 'open' })]).toEqual([])
    expect(empty.size).toBe(0)
    expect([...closed]).toEqual([A])
  })
  test('returns the same set when nothing changed', () => {
    const failed = noteRelay(empty, { url: A, status: 'closed' })
    expect(noteRelay(failed, { url: A, status: 'connecting' })).toBe(failed)
    expect(noteRelay(failed, { url: A, status: 'error' })).toBe(failed)
    expect(noteRelay(empty, { url: A, status: 'open' })).toBe(empty)
  })
})

describe('relayHealth', () => {
  const failed: FailedRelays = new Set([A, B])
  test('ok while nothing has failed everywhere', () => {
    expect(relayHealth([], failed)).toBe('ok')
    expect(relayHealth([{ url: A, status: 'connecting' }], new Set())).toBe('ok')
    expect(relayHealth([{ url: A, status: 'closed' }, { url: B, status: 'open' }], failed)).toBe('ok')
    expect(relayHealth([{ url: A, status: 'closed' }, { url: B, status: 'connecting' }], new Set([A]))).toBe('ok')
  })
  test('down once every relay failed and none is open', () => {
    expect(relayHealth([{ url: A, status: 'connecting' }, { url: B, status: 'closed' }], failed)).toBe('down')
  })
  test('ignores failures of relays no longer in the list', () => {
    expect(relayHealth([{ url: B, status: 'connecting' }], new Set([A]))).toBe('ok')
  })
})

describe('relay health against a real relay', () => {
  let relay: TestRelay
  let engine: Kurultay | undefined
  afterAll(async () => {
    await engine?.stop()
    relay.stop()
  })

  async function until(cond: () => boolean, ms = 8000) {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('timeout waiting for condition')
      await Bun.sleep(20)
    }
  }

  test('goes down when the relay stops and recovers when it returns', async () => {
    relay = startTestRelay(0)
    const port = relay.port
    const e = new Kurultay({ sk: newSecretKey(), name: 'watcher', kind: 'human', relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000 })
    engine = e
    let failed: FailedRelays = new Set()
    e.on('relay', (r) => {
      failed = noteRelay(failed, r)
    })
    const health = () => relayHealth(e.pool.relays, failed)
    await e.start()
    await until(() => e.pool.relays.every((r) => r.status === 'open'))
    expect(health()).toBe('ok')

    relay.stop()
    await until(() => health() === 'down')

    relay = startTestRelay(port)
    await until(() => health() === 'ok' && e.pool.relays.every((r) => r.status === 'open'))
  }, 20_000)
})
