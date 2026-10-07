import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PairPoll, PairRequest } from '@kurultay/core'

/**
 * Pairs a browser with this daemon. The page asks for a code and shows it; the owner confirms that code in a terminal
 * (`kurultay pair <code>`), which a web page cannot do. Only then does the page receive a token, exactly once. Tokens are
 * stored as SHA-256 hashes, so a leaked pairings file cannot be replayed.
 *
 * The state machine is pure (clock and randomness are passed in); only `createPairing` touches pairings.json.
 */

export const REQUEST_TTL_MS = 5 * 60_000
export const MAX_PENDING = 3

export interface PendingPair {
  readonly id: string
  readonly code: string
  readonly origin: string
  readonly expires: number
  /** set once approved, cleared from state when the page collects it */
  readonly token?: string
}

export interface PairingState {
  readonly pending: readonly PendingPair[]
}

export interface PairedToken {
  readonly hash: string
  readonly origin: string
  readonly at: number
}

export type PairingErrorCode = 'unknown-code' | 'expired' | 'no-origin'

export class PairingError extends Error {
  constructor(
    readonly code: PairingErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface PairingDeps {
  readonly now: number
  /** `n` cryptographically random bytes */
  readonly random: (n: number) => Uint8Array
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
/** 6 digits from 32 random bits: the modulo bias (< 0.03 %) is irrelevant for a 5-minute, 3-slot code */
const sixDigits = (b: Uint8Array) => String(Buffer.from(b).readUInt32BE(0) % 1_000_000).padStart(6, '0')

export const EMPTY_PAIRING: PairingState = { pending: [] }

export const sweep = (s: PairingState, now: number): PairingState => ({ pending: s.pending.filter((p) => p.expires >= now) })

export function request(s: PairingState, origin: string | undefined, d: PairingDeps): [PairingState, PairRequest] {
  // a bare local client has no business asking: pairing is for a web page, and the terminal approves out of band
  if (!origin) throw new PairingError('no-origin', 'pairing must come from the web app')
  const p: PendingPair = { id: hex(d.random(8)), code: sixDigits(d.random(4)), origin, expires: d.now + REQUEST_TTL_MS }
  // a page that keeps asking cannot bury a real request: the oldest one is dropped
  const kept = sweep(s, d.now).pending.slice(-(MAX_PENDING - 1))
  return [{ pending: [...kept, p] }, { id: p.id, code: p.code, expiresIn: REQUEST_TTL_MS / 1000 }]
}

/** What `kurultay pair` lists: origin and age, never the code (the owner has to read it off the page). */
export const list = (s: PairingState, now: number) =>
  sweep(s, now)
    .pending.filter((p) => !p.token)
    .map((p) => ({ origin: p.origin, expiresIn: Math.round((p.expires - now) / 1000) }))

/** Called from the local socket only. Returns the minted token so the caller can persist its hash. */
export function approve(s: PairingState, code: string, d: PairingDeps): [PairingState, { origin: string; token: string }] {
  const match = s.pending.find((p) => !p.token && p.code === code.trim())
  if (!match) throw new PairingError('unknown-code', 'No pairing request with that code. Ask the app for a new one.')
  if (match.expires < d.now) throw new PairingError('expired', 'That code expired. Ask the app for a new one.')
  const token = hex(d.random(32))
  return [{ pending: sweep(s, d.now).pending.map((p) => (p === match ? { ...p, token } : p)) }, { origin: match.origin, token }]
}

/** The token is handed over once, to the page that asked; afterwards the id reads as expired. */
export function poll(s: PairingState, id: string, now: number): [PairingState, PairPoll] {
  const live = sweep(s, now)
  const p = live.pending.find((x) => x.id === id)
  if (!p) return [live, { status: 'expired' }]
  if (!p.token) return [live, { status: 'pending' }]
  return [{ pending: live.pending.filter((x) => x !== p) }, { status: 'approved', token: p.token }]
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** Constant-time compare of the token's hash against every stored hash. */
export function verify(tokens: readonly PairedToken[], token: string | undefined): boolean {
  if (!token) return false
  const h = Buffer.from(hashToken(token))
  return tokens.some((t) => {
    const known = Buffer.from(t.hash)
    return known.length === h.length && timingSafeEqual(known, h)
  })
}

/** Forget one token (a page signing out) or, without one, every browser. */
export const revoke = (tokens: readonly PairedToken[], token?: string): PairedToken[] => (token ? tokens.filter((t) => t.hash !== hashToken(token)) : [])

export type Pairing = ReturnType<typeof createPairing>

/** The daemon's pairing: pending requests live in memory, approved token hashes in `file` (mode 0600). */
export function createPairing(file: string, deps: () => PairingDeps = () => ({ now: Date.now(), random: (n) => randomBytes(n) })) {
  let state = EMPTY_PAIRING
  const read = (): PairedToken[] => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return Array.isArray(parsed) ? (parsed as PairedToken[]) : []
    } catch {
      // no file yet means nobody is paired; a corrupt one fails closed the same way
      return []
    }
  }
  const write = (t: readonly PairedToken[]) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, JSON.stringify(t, null, 2), { mode: 0o600 })
    chmodSync(file, 0o600)
  }
  return {
    request(origin: string | undefined) {
      const [next, r] = request(state, origin, deps())
      state = next
      return r
    },
    approve(code: string) {
      const d = deps()
      const [next, r] = approve(state, code, d)
      state = next
      write([...read(), { hash: hashToken(r.token), origin: r.origin, at: d.now }])
      return { origin: r.origin }
    },
    poll(id: string) {
      const [next, r] = poll(state, id, deps().now)
      state = next
      return r
    },
    list: () => list(state, deps().now),
    verify: (token: string | undefined) => verify(read(), token),
    revoke: (token?: string) => write(revoke(read(), token)),
    pairedCount: () => read().length,
  }
}
