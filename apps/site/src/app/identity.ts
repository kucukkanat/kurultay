import { bytesToHex, getPublicKey, hexToBytes, newSecretKey, type BoardElement, type State, type Storage } from '@kurultay/core'
import * as nip19 from 'nostr-tools/nip19'

const ID_KEY = 'kurultay:identity'

export type IdentityRecord =
  | { v: 1; name: string; pubkey: string; mode: 'local'; sk: string }
  | { v: 1; name: string; pubkey: string; mode: 'passkey'; credId: string; salt: string; iv: string; ct: string }

export interface Unlocked {
  record: IdentityRecord
  sk: Uint8Array
  /** AES key protecting app state at rest (passkey mode only) */
  aes: CryptoKey | null
}

// in slices: spreading a whole board's bytes as arguments would overflow the call stack
const b64 = (b: ArrayBuffer | Uint8Array) => {
  const u = new Uint8Array(b as ArrayBuffer)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n))

export function loadIdentity(): IdentityRecord | null {
  try {
    const raw = localStorage.getItem(ID_KEY)
    return raw ? (JSON.parse(raw) as IdentityRecord) : null
  } catch {
    return null
  }
}

function saveIdentity(r: IdentityRecord) {
  localStorage.setItem(ID_KEY, JSON.stringify(r))
}

export function forgetIdentity(pubkey: string) {
  localStorage.removeItem(ID_KEY)
  localStorage.removeItem('kurultay:state:' + pubkey)
  for (const k of storedKeys().filter((k) => k.startsWith(boardPrefix(pubkey)))) localStorage.removeItem(k)
  void idbDel(pubkey)
}

// ---- remembered unlock: a non-extractable AES key kept in IndexedDB so a reload doesn't ask for the passkey again.
// The key can be used by this origin but never read out, so it can't be exfiltrated as bytes.
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('kurultay', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('unlock')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function idbTx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await idb()
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction('unlock', mode).objectStore('unlock'))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return undefined
  }
}
const idbGet = (k: string) => idbTx<CryptoKey>('readonly', (s) => s.get(k) as IDBRequest<CryptoKey>)
const idbPut = (k: string, v: CryptoKey) => idbTx('readwrite', (s) => s.put(v, k))
const idbDel = (k: string) => idbTx('readwrite', (s) => s.delete(k))

/** Lock the app on this device: the next visit needs the passkey again. */
export async function lockIdentity(pubkey: string) {
  await idbDel(pubkey)
}

/** Unlock without user interaction when possible (local key, or a remembered passkey unlock). */
export async function quietUnlock(record: IdentityRecord): Promise<Unlocked | null> {
  if (record.mode === 'local') return { record, sk: hexToBytes(record.sk), aes: null }
  const aes = await idbGet(record.pubkey)
  if (!aes) return null
  try {
    const sk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, aes, unb64(record.ct)))
    return getPublicKey(sk) === record.pubkey ? { record, sk, aes } : null
  } catch {
    return null
  }
}

export function renameIdentity(name: string) {
  const r = loadIdentity()
  if (!r) return
  r.name = name
  saveIdentity(r)
}

export function passkeySupported() {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials
}

async function aesFromPrf(prf: ArrayBuffer): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('kurultay/identity'), info: new TextEncoder().encode('aes-gcm') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function prfAssert(credId: Uint8Array, salt: Uint8Array): Promise<ArrayBuffer> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: 'public-key', id: credId as BufferSource }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  const res = (cred?.getClientExtensionResults() as any)?.prf?.results?.first as ArrayBuffer | undefined
  if (!res) throw new Error('This passkey did not return a PRF secret. Use a local key instead, or try a different authenticator.')
  return res
}

export function parseSecret(input: string): Uint8Array {
  const s = input.trim()
  if (s.startsWith('nsec1')) {
    const d = nip19.decode(s)
    if (d.type !== 'nsec') throw new Error('Not an nsec key')
    return d.data as Uint8Array
  }
  if (/^[0-9a-f]{64}$/i.test(s)) return hexToBytes(s.toLowerCase())
  throw new Error('Paste an nsec1… key or 64 hex characters')
}

export function nsecOf(sk: Uint8Array) {
  return nip19.nsecEncode(sk)
}

export async function createIdentity(name: string, mode: 'local' | 'passkey', imported?: Uint8Array): Promise<Unlocked> {
  const sk = imported ?? newSecretKey()
  const pubkey = getPublicKey(sk)
  if (mode === 'local') {
    const record: IdentityRecord = { v: 1, name, pubkey, mode: 'local', sk: bytesToHex(sk) }
    saveIdentity(record)
    return { record, sk, aes: null }
  }
  const salt = rand(32)
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: rand(32),
      rp: { name: 'Kurultay' },
      user: { id: rand(16), name, displayName: name },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new Error('Passkey creation was cancelled')
  const ext = (cred.getClientExtensionResults() as any)?.prf
  if (ext && ext.enabled === false) throw new Error('This authenticator does not support the PRF extension. Choose a local key instead.')
  const credId = new Uint8Array(cred.rawId)
  const prf: ArrayBuffer = ext?.results?.first ?? (await prfAssert(credId, salt))
  const aes = await aesFromPrf(prf)
  const iv = rand(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, sk as BufferSource)
  const record: IdentityRecord = { v: 1, name, pubkey, mode: 'passkey', credId: b64(credId), salt: b64(salt), iv: b64(iv), ct: b64(ct) }
  saveIdentity(record)
  await idbPut(pubkey, aes)
  return { record, sk, aes }
}

export async function unlock(record: IdentityRecord): Promise<Unlocked> {
  if (record.mode === 'local') return { record, sk: hexToBytes(record.sk), aes: null }
  const prf = await prfAssert(unb64(record.credId), unb64(record.salt))
  const aes = await aesFromPrf(prf)
  const sk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, aes, unb64(record.ct)))
  if (getPublicKey(sk) !== record.pubkey) throw new Error('Decrypted key does not match this identity')
  await idbPut(record.pubkey, aes)
  return { record, sk, aes }
}

const boardPrefix = (pubkey: string) => `kurultay:board:${pubkey}:`
const storedKeys = (): string[] => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '')

/**
 * Room for all of one identity's boards, in localStorage characters. An origin gets about 5 MB; boards may use this much
 * and no more, so a busy board can never take the space that keys and councils need.
 */
export const BOARD_STORE_CHARS = 2_000_000

/** A board that would push this device's boards past BOARD_STORE_CHARS; it is not kept here, peers send it again. */
export class BoardStoreFullError extends Error {}

/**
 * Engine state in localStorage, encrypted with the passkey-derived key when available. Boards are kept apart, one key per
 * council, under BOARD_STORE_CHARS. A failed save throws, and the engine tells the user.
 */
export class BrowserStorage implements Storage {
  private key: string
  constructor(
    private pubkey: string,
    private aes: CryptoKey | null,
  ) {
    this.key = 'kurultay:state:' + pubkey
  }
  private async seal(value: unknown): Promise<string> {
    const json = JSON.stringify(value)
    if (!this.aes) return json
    const iv = rand(12)
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.aes, new TextEncoder().encode(json))
    return JSON.stringify({ enc: 1, iv: b64(iv), ct: b64(ct) })
  }
  /** What `seal` wrote, or null when it is missing or cannot be read with this key. */
  private async open<T>(key: string): Promise<T | null> {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    try {
      const obj = JSON.parse(raw)
      if (obj.enc && this.aes) {
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(obj.iv) }, this.aes, unb64(obj.ct))
        return JSON.parse(new TextDecoder().decode(pt))
      }
      return obj.enc ? null : obj
    } catch {
      return null
    }
  }
  load(): Promise<State | null> {
    return this.open<State>(this.key)
  }
  async save(state: State) {
    localStorage.setItem(this.key, await this.seal(state))
  }
  loadBoard(groupId: string): Promise<Record<string, BoardElement> | null> {
    return this.open<Record<string, BoardElement>>(boardPrefix(this.pubkey) + groupId)
  }
  async saveBoard(groupId: string, board: Record<string, BoardElement> | null) {
    const key = boardPrefix(this.pubkey) + groupId
    if (!board || !Object.keys(board).length) return localStorage.removeItem(key)
    const sealed = await this.seal(board)
    const others = storedKeys()
      .filter((k) => k.startsWith(boardPrefix(this.pubkey)) && k !== key)
      .reduce((n, k) => n + (localStorage.getItem(k)?.length ?? 0), 0)
    if (others + sealed.length > BOARD_STORE_CHARS) {
      // an older, smaller copy would come back on reload looking current: drop it, the council has the board
      localStorage.removeItem(key)
      throw new BoardStoreFullError(`boards on this device may use ${(BOARD_STORE_CHARS / 1e6).toFixed(0)} MB`)
    }
    localStorage.setItem(key, sealed)
  }
}
