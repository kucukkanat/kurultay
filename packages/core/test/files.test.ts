import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey, paddedLength, decryptFile, encryptFile, cleanFileRefs, type FileRef } from '../src'
import { startTestBlossom, startTestRelay, type TestBlossom, type TestRelay } from '../src/testing'

let relay: TestRelay
let blossom: TestBlossom
const peers: Kurultay[] = []
beforeAll(() => {
  relay = startTestRelay(0)
  blossom = startTestBlossom(0)
})
afterAll(async () => {
  await Promise.all(peers.map((p) => p.stop()))
  relay.stop()
  blossom.stop()
})
const until = async (cond: () => unknown, ms = 8000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout')
    await Bun.sleep(30)
  }
}
async function peer(name: string, kind: 'human' | 'agent' = 'human') {
  const p = new Kurultay({ sk: newSecretKey(), name, kind, relays: [relay.url], storage: new MemoryStorage(), presenceInterval: 3_600_000, blossom: [blossom.url] })
  peers.push(p)
  await p.start()
  return p
}

test('encryption round-trip, padding hides the exact size, tampering is caught', async () => {
  const data = new TextEncoder().encode('hello council')
  const enc = await encryptFile(data)
  expect(enc.blob.length).toBe(paddedLength(data.length) + 16)
  const ref = { key: enc.key, iv: enc.iv, size: data.length, sha256: enc.sha256 }
  expect(new TextDecoder().decode(await decryptFile(enc.blob, ref))).toBe('hello council')
  const bad = enc.blob.slice()
  bad[0] ^= 1
  await expect(decryptFile(bad, ref)).rejects.toThrow(/altered/)
  expect(paddedLength(100_000)).toBeGreaterThanOrEqual(100_000)
  expect(paddedLength(100_000) / 100_000).toBeLessThan(1.07)
})

test('a file sent in a council: members open it, the server and outsiders see only ciphertext', async () => {
  const alice = await peer('alice')
  const bob = await peer('bob')
  const g = alice.createGroup('files')
  await bob.redeem(alice.createInvite(g.id))
  await until(() => bob.state.groups[g.id])

  const secret = new TextEncoder().encode('quarterly numbers: 42 '.repeat(500))
  const ref = await alice.uploadFile(secret, '../../etc/report.txt', 'text/plain')
  expect(ref.name).toBe('report.txt')
  await alice.send(g.id, 'here is the report', { files: [ref] })
  await until(() => bob.state.groups[g.id].history.some((m) => m.files?.length))
  const got = bob.state.groups[g.id].history.find((m) => m.files?.length)!.files![0]
  expect(got.name).toBe('report.txt')
  const bytes = await bob.downloadFile(got)
  expect(new TextDecoder().decode(bytes)).toBe(new TextDecoder().decode(secret))

  // what the Blossom server holds is opaque
  const stored = [...blossom.blobs.values()].map((b) => new TextDecoder().decode(b.data))
  expect(stored.some((s) => s.includes('quarterly'))).toBe(false)
  // nor does any relay event carry the key in the clear
  expect(relay.observed.some((e) => e.content.includes(ref.key))).toBe(false)
  // the uploader is a throwaway key, not alice
  expect(blossom.blobs.get(ref.sha256)!.owner).not.toBe(alice.pubkey)
})

test('the sender deletes expired uploads', async () => {
  const carol = await peer('carol')
  const ref = await carol.uploadFile(new Uint8Array([1, 2, 3]), 'tiny.bin', 'application/octet-stream', { ttl: -1 })
  expect(blossom.blobs.has(ref.sha256)).toBe(true)
  await carol.sweepUploads()
  expect(blossom.blobs.has(ref.sha256)).toBe(false)
  expect(carol.state.uploads?.[ref.sha256]).toBeUndefined()
  await expect(carol.downloadFile(ref)).rejects.toThrow(/expired/)
})

test('malformed or hostile file refs from peers are dropped or neutralised', () => {
  const good: FileRef = { name: 'a.png', mime: 'image/png', size: 10, sha256: 'a'.repeat(64), servers: ['https://nostr.download/'], key: 'b'.repeat(64), iv: 'c'.repeat(24) }
  const out = cleanFileRefs([
    good,
    { ...good, servers: ['javascript:alert(1)'] },
    { ...good, servers: ['http://evil.example'] },
    { ...good, key: 'short' },
    { ...good, size: 10 ** 12 },
    { ...good, name: '..\\\\..\\\\x<script>.png', mime: 'text/html; x' },
  ])!
  expect(out).toHaveLength(2)
  expect(out[0].servers).toEqual(['https://nostr.download'])
  expect(out[1].name).toBe('xscript.png')
  expect(out[1].mime).toBe('application/octet-stream')
})
