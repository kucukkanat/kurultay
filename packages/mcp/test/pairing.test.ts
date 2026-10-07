import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approve, createPairing, EMPTY_PAIRING, hashToken, list, MAX_PENDING, PairingError, poll, request, REQUEST_TTL_MS, revoke, verify, type PairingDeps } from '../src/pairing'

const at = (now: number): PairingDeps => ({ now, random: (n) => randomBytes(n) })
const ORIGIN = 'http://app.test'

const errorCode = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    return err instanceof PairingError ? err.code : 'other'
  }
  return 'none'
}

describe('pairing state machine', () => {
  test('codes are 6 digits and at most three requests wait, oldest dropped', () => {
    let s = EMPTY_PAIRING
    const ids: string[] = []
    for (let i = 0; i < MAX_PENDING + 2; i++) {
      const [next, r] = request(s, ORIGIN, at(1000 + i))
      expect(r.code).toMatch(/^\d{6}$/)
      expect(r.expiresIn).toBe(REQUEST_TTL_MS / 1000)
      s = next
      ids.push(r.id)
    }
    expect(s.pending.map((p) => p.id)).toEqual(ids.slice(-MAX_PENDING))
  })

  test('a request needs an origin', () => expect(errorCode(() => request(EMPTY_PAIRING, undefined, at(0)))).toBe('no-origin'))

  test('codes expire on the injected clock', () => {
    const [s, r] = request(EMPTY_PAIRING, ORIGIN, at(0))
    expect(poll(s, r.id, REQUEST_TTL_MS)[1]).toEqual({ status: 'pending' })
    expect(poll(s, r.id, REQUEST_TTL_MS + 1)[1]).toEqual({ status: 'expired' })
    expect(errorCode(() => approve(s, r.code, at(REQUEST_TTL_MS + 1)))).toBe('expired')
    expect(errorCode(() => approve(s, r.code === '000000' ? '111111' : '000000', at(1)))).toBe('unknown-code')
  })

  test('the token is handed out once, and approving does not mutate the old state', () => {
    const [s0, r] = request(EMPTY_PAIRING, ORIGIN, at(0))
    const [s1, ok] = approve(s0, ` ${r.code} `, at(1))
    expect(ok.origin).toBe(ORIGIN)
    expect(ok.token).toMatch(/^[0-9a-f]{64}$/)
    expect(s0.pending[0].token).toBeUndefined()
    const [s2, first] = poll(s1, r.id, 2)
    expect(first).toEqual({ status: 'approved', token: ok.token })
    expect(poll(s2, r.id, 3)[1]).toEqual({ status: 'expired' })
    // an approved code cannot be approved again
    expect(errorCode(() => approve(s1, r.code, at(2)))).toBe('unknown-code')
  })

  test('list shows origin and remaining time, never the code', () => {
    const [s, r] = request(EMPTY_PAIRING, ORIGIN, at(0))
    const shown = list(s, 60_000)
    expect(shown).toEqual([{ origin: ORIGIN, expiresIn: REQUEST_TTL_MS / 1000 - 60 }])
    expect(JSON.stringify(shown)).not.toContain(r.code)
  })

  test('verify rejects wrong and empty tokens; revoke forgets one or all', () => {
    const tokens = ['a', 'b'].map((t) => ({ hash: hashToken(t), origin: ORIGIN, at: 0 }))
    expect(verify(tokens, 'a')).toBe(true)
    expect(verify(tokens, 'c')).toBe(false)
    expect(verify(tokens, '')).toBe(false)
    expect(verify(tokens, undefined)).toBe(false)
    expect(verify(revoke(tokens, 'a'), 'a')).toBe(false)
    expect(verify(revoke(tokens, 'a'), 'b')).toBe(true)
    expect(revoke(tokens)).toEqual([])
  })
})

test('createPairing persists only token hashes, in a private file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'kurultay-pairing-')), 'pairings.json')
  const p = createPairing(file)
  const r = p.request(ORIGIN)
  expect(p.list()).toHaveLength(1)
  expect(p.approve(r.code)).toEqual({ origin: ORIGIN })
  const got = p.poll(r.id)
  if (got.status !== 'approved') throw new Error(`expected approved, got ${got.status}`)
  expect(readFileSync(file, 'utf8')).not.toContain(got.token)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  // a fresh daemon (restart) still knows the browser
  expect(createPairing(file).verify(got.token)).toBe(true)
  expect(p.pairedCount()).toBe(1)
  p.revoke(got.token)
  expect(p.verify(got.token)).toBe(false)
})
