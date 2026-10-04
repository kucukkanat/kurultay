import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { formatBytes, KurultayError, MAX_FILE_BYTES, safeFileName, type FileRef, type Kurultay, type Message } from '@kurultay/core'

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.log': 'text/plain',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.ts': 'text/plain',
  '.js': 'text/javascript',
  '.py': 'text/x-python',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
}
const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'

/** PNG/JPEG/GIF/WebP dimensions from the header, so the app can lay out images before decrypting them */
function imageSize(b: Uint8Array, mime: string): { width?: number; height?: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  try {
    if (mime === 'image/png' && b.length > 24) return { width: dv.getUint32(16), height: dv.getUint32(20) }
    if (mime === 'image/gif' && b.length > 10) return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) }
    if (mime === 'image/jpeg') {
      for (let i = 2; i < b.length - 9; ) {
        if (b[i] !== 0xff) break
        const marker = b[i + 1]
        const len = dv.getUint16(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) }
        i += 2 + len
      }
    }
  } catch {}
  return {}
}

/** Encrypt and upload local files; `within` confines paths to a folder (background turns). */
export async function uploadPaths(e: Kurultay, paths: string[], base: string, within?: string): Promise<FileRef[]> {
  const refs: FileRef[] = []
  for (const p of paths) {
    const full = isAbsolute(p) ? p : resolve(base, p)
    if (!existsSync(full)) throw new KurultayError(`No such file: ${p}`)
    if (within) {
      const real = realpathSync(full)
      const rel = relative(realpathSync(within), real)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new KurultayError(`${p} is outside the working folder`)
    }
    const st = statSync(full)
    if (!st.isFile()) throw new KurultayError(`${p} is not a file`)
    if (st.size > MAX_FILE_BYTES) throw new KurultayError(`${p} is ${formatBytes(st.size)}; the limit is ${formatBytes(MAX_FILE_BYTES)}`)
    const bytes = new Uint8Array(readFileSync(full))
    const mime = mimeOf(full)
    refs.push(await e.uploadFile(bytes, basename(full), mime, imageSize(bytes, mime)))
  }
  return refs
}

/** What agents see of an attachment in `wait` / `history`: never the key. */
export const describeFiles = (files?: FileRef[]) =>
  files?.map((f, i) => ({ index: i, name: f.name, type: f.mime, size: formatBytes(f.size), expired: !!f.expiresAt && f.expiresAt < Date.now() / 1000 }))

/** a free path in `dir` for `name` (never overwrites) */
function freePath(dir: string, name: string) {
  const safe = safeFileName(name)
  const ext = extname(safe)
  const stem = safe.slice(0, safe.length - ext.length)
  let p = join(dir, safe)
  for (let i = 2; existsSync(p); i++) p = join(dir, `${stem}-${i}${ext}`)
  return p
}

/** Download, decrypt and save a message's attachments into `dir`. Returns the saved paths. */
export async function saveFiles(e: Kurultay, m: Message, dir: string, which?: (f: FileRef, i: number) => boolean) {
  mkdirSync(dir, { recursive: true })
  const saved: { name: string; path: string }[] = []
  for (const [i, f] of (m.files ?? []).entries()) {
    if (which && !which(f, i)) continue
    const bytes = await e.downloadFile(f)
    const path = freePath(dir, f.name)
    writeFileSync(path, bytes)
    saved.push({ name: f.name, path })
  }
  return saved
}

/** Where background turns put attachments: a hidden, git-ignored folder inside the working folder. */
export function inboxDir(workdir: string) {
  const dir = join(workdir, '.kurultay', 'files')
  mkdirSync(dir, { recursive: true })
  const ignore = join(workdir, '.kurultay', '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  return dir
}

/** `[[attach: path]]` lines in a background answer: files the agent wants to share. */
export function extractAttachments(answer: string) {
  const paths: string[] = []
  const text = answer
    .replace(/^[ \t]*\[\[attach:\s*(.+?)\s*\]\][ \t]*$/gim, (_m, p: string) => {
      paths.push(p.replace(/^["'`]|["'`]$/g, ''))
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, paths: paths.slice(0, 10) }
}
