import { bytesToHex, getPublicKey, hexToBytes, newSecretKey, type State, type Storage } from '@kurultay/core'
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

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
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
  return { record, sk, aes }
}

export async function unlock(record: IdentityRecord): Promise<Unlocked> {
  if (record.mode === 'local') return { record, sk: hexToBytes(record.sk), aes: null }
  const prf = await prfAssert(unb64(record.credId), unb64(record.salt))
  const aes = await aesFromPrf(prf)
  const sk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(record.iv) }, aes, unb64(record.ct)))
  if (getPublicKey(sk) !== record.pubkey) throw new Error('Decrypted key does not match this identity')
  return { record, sk, aes }
}

/** Engine state in localStorage; encrypted with the passkey-derived key when available. */
export class BrowserStorage implements Storage {
  private key: string
  constructor(
    pubkey: string,
    private aes: CryptoKey | null,
  ) {
    this.key = 'kurultay:state:' + pubkey
  }
  async load(): Promise<State | null> {
    const raw = localStorage.getItem(this.key)
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
  async save(state: State) {
    const json = JSON.stringify(state)
    try {
      if (this.aes) {
        const iv = rand(12)
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.aes, new TextEncoder().encode(json))
        localStorage.setItem(this.key, JSON.stringify({ enc: 1, iv: b64(iv), ct: b64(ct) }))
      } else {
        localStorage.setItem(this.key, json)
      }
    } catch (err) {
      console.warn('[kurultay] could not save state', err)
    }
  }
}
