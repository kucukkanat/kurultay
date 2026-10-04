/**
 * Encrypted file attachments over Blossom (BUD-01/02).
 *
 * Every file gets its own random AES-256-GCM key. The file is padded, encrypted and uploaded as an opaque
 * blob, signed by a throwaway key, so the server sees neither content, type, name nor uploader. The key, the
 * blob hash and the file's metadata travel only inside the council's encrypted `chat` envelope (a FileRef).
 */
import { finalizeEvent, generateSecretKey } from 'nostr-tools'
import { bytesToHex, hexToBytes, now } from './util'

export interface FileRef {
  /** display name (no path) */
  name: string
  mime: string
  /** plaintext size in bytes */
  size: number
  /** sha256 of the encrypted blob, as stored on Blossom */
  sha256: string
  /** Blossom servers that hold the blob (origins, e.g. https://nostr.download) */
  servers: string[]
  /** AES-256-GCM key and IV, hex */
  key: string
  iv: string
  /** when the sender's client deletes the blob (unix seconds) */
  expiresAt?: number
  /** image dimensions, when known */
  width?: number
  height?: number
}

export const MAX_FILE_BYTES = 25 * 1024 * 1024
export const MAX_FILES_PER_MESSAGE = 10
/** free public Blossom servers that accept opaque blobs and allow CORS */
export const DEFAULT_BLOSSOM = ['https://nostr.download', 'https://files.sovbit.host']
/** sender deletes uploads after this long */
export const FILE_TTL = 24 * 3600

/** Uploads I made: what my client must delete, and when. */
export interface UploadRecord {
  sha256: string
  servers: string[]
  /** throwaway key that signed the upload (needed to delete it) */
  sk: string
  expiresAt: number
  name: string
}

const subtle = () => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is not available')
  return s
}

const toHex = (buf: ArrayBuffer) => bytesToHex(new Uint8Array(buf))
export const sha256Hex = async (b: Uint8Array) => toHex(await subtle().digest('SHA-256', b as BufferSource))

/** Pad to a size bucket (≤ 6.25 % overhead) so the blob size only roughly reveals the file size. */
export function paddedLength(n: number) {
  if (n <= 4096) return 4096
  const step = Math.max(4096, 2 ** (Math.floor(Math.log2(n)) - 4))
  return Math.ceil(n / step) * step
}

export async function encryptFile(plain: Uint8Array) {
  if (plain.length > MAX_FILE_BYTES) throw new Error(`File too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)`)
  const key = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const padded = new Uint8Array(paddedLength(plain.length))
  padded.set(plain)
  const k = await subtle().importKey('raw', key, 'AES-GCM', false, ['encrypt'])
  const blob = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, k, padded))
  return { blob, key: bytesToHex(key), iv: bytesToHex(iv), sha256: await sha256Hex(blob) }
}

export async function decryptFile(blob: Uint8Array, ref: Pick<FileRef, 'key' | 'iv' | 'size' | 'sha256'>) {
  if ((await sha256Hex(blob)) !== ref.sha256) throw new Error('File was altered: hash mismatch')
  const k = await subtle().importKey('raw', hexToBytes(ref.key) as BufferSource, 'AES-GCM', false, ['decrypt'])
  const padded = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: hexToBytes(ref.iv) as BufferSource }, k, blob as BufferSource))
  return padded.slice(0, ref.size)
}

function authHeader(sk: Uint8Array, verb: 'upload' | 'delete', sha256: string) {
  const ev = finalizeEvent({ kind: 24242, created_at: now(), content: verb === 'upload' ? 'Upload blob' : 'Delete blob', tags: [['t', verb], ['x', sha256], ['expiration', String(now() + 600)]] }, sk)
  return 'Nostr ' + btoa(JSON.stringify(ev))
}

export const normalizeServer = (s: string) => s.trim().replace(/\/+$/, '')

/** Upload to the first server that accepts the blob. Returns where it landed and the key that can delete it. */
export async function uploadBlob(servers: string[], blob: Uint8Array, sha256: string, opts: { signal?: AbortSignal } = {}) {
  const sk = generateSecretKey()
  const errors: string[] = []
  for (const server of servers.map(normalizeServer)) {
    try {
      const r = await fetch(`${server}/upload`, {
        method: 'PUT',
        body: blob as BodyInit,
        headers: { Authorization: authHeader(sk, 'upload', sha256), 'Content-Type': 'application/octet-stream', 'X-SHA-256': sha256 },
        signal: opts.signal,
      })
      if (!r.ok) {
        errors.push(`${new URL(server).host}: ${r.status} ${(r.headers.get('x-reason') ?? '').slice(0, 80)}`)
        continue
      }
      const d = (await r.json().catch(() => ({}))) as { sha256?: string }
      if (d.sha256 && d.sha256 !== sha256) {
        errors.push(`${new URL(server).host}: stored a different hash`)
        continue
      }
      return { server, sk: bytesToHex(sk) }
    } catch (err) {
      if (opts.signal?.aborted) throw err
      errors.push(`${server}: ${(err as Error).message}`)
    }
  }
  throw new Error(`Upload failed. ${errors.join('; ')}`)
}

export async function deleteBlob(server: string, sha256: string, skHex: string) {
  const r = await fetch(`${normalizeServer(server)}/${sha256}`, { method: 'DELETE', headers: { Authorization: authHeader(hexToBytes(skHex), 'delete', sha256) } })
  // 404: already gone (or the server expired it)
  return r.ok || r.status === 404
}

/** Download, verify and decrypt. Tries every server the sender listed. */
export async function downloadFile(ref: FileRef, opts: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
  const errors: string[] = []
  for (const server of ref.servers) {
    try {
      const r = await fetch(`${normalizeServer(server)}/${ref.sha256}`, { signal: opts.signal })
      if (!r.ok) {
        errors.push(`${new URL(server).host}: ${r.status === 404 ? 'gone' : r.status}`)
        continue
      }
      return await decryptFile(new Uint8Array(await r.arrayBuffer()), ref)
    } catch (err) {
      if (opts.signal?.aborted) throw err
      errors.push(`${server}: ${(err as Error).message}`)
    }
  }
  throw new Error(ref.expiresAt && ref.expiresAt < now() ? 'This file has expired' : `Download failed. ${errors.join('; ')}`)
}

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`)

/** Peers send FileRefs: keep only well-formed ones, with a safe name and https servers. */
export function cleanFileRefs(input: unknown): FileRef[] | undefined {
  if (!Array.isArray(input)) return undefined
  const out: FileRef[] = []
  for (const f of input.slice(0, MAX_FILES_PER_MESSAGE)) {
    if (!f || typeof f !== 'object') continue
    const r = f as Record<string, unknown>
    if (typeof r.sha256 !== 'string' || !HEX(64).test(r.sha256)) continue
    if (typeof r.key !== 'string' || !HEX(64).test(r.key) || typeof r.iv !== 'string' || !HEX(24).test(r.iv)) continue
    const size = Number(r.size)
    if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) continue
    const servers = (Array.isArray(r.servers) ? r.servers : [])
      .filter((s): s is string => typeof s === 'string')
      .map(normalizeServer)
      .filter((s) => /^https:\/\/[^/\s]+$/.test(s) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(s))
      .slice(0, 4)
    if (!servers.length) continue
    out.push({
      name: safeFileName(String(r.name ?? 'file')),
      mime: typeof r.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(r.mime) ? r.mime : 'application/octet-stream',
      size,
      sha256: r.sha256,
      servers,
      key: r.key,
      iv: r.iv,
      expiresAt: Number.isFinite(Number(r.expiresAt)) ? Number(r.expiresAt) : undefined,
      width: Number.isInteger(r.width) ? (r.width as number) : undefined,
      height: Number.isInteger(r.height) ? (r.height as number) : undefined,
    })
  }
  return out.length ? out : undefined
}

/** A name that is safe to show and to save: no path, no control characters. */
export function safeFileName(name: string) {
  const base = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/^\.+/, '').trim()
  return (base || 'file').slice(0, 120)
}

export function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`
}
