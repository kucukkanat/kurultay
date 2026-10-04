import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js'

export { bytesToHex, hexToBytes }

export const now = () => Math.floor(Date.now() / 1000)
export const randomHex = (n = 32) => bytesToHex(randomBytes(n))

const enc = new TextEncoder()
const dec = new TextDecoder()
export const utf8 = (s: string) => enc.encode(s)
export const fromUtf8 = (b: Uint8Array) => dec.decode(b)

export function b64urlEncode(s: string): string {
  const bytes = utf8(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return fromUtf8(bytes)
}

type Listener<T> = (payload: T) => void

/** Minimal typed event emitter that works in browsers, Bun and Node. */
export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>()

  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(fn)
    return () => set!.delete(fn)
  }

  protected emit<K extends keyof Events>(type: K, payload: Events[K]) {
    const set = this.listeners.get(type)
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(payload)
      } catch (err) {
        console.error('[kurultay] listener error', err)
      }
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function shortKey(pk: string) {
  return pk.slice(0, 8) + '…' + pk.slice(-4)
}
