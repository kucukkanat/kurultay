import { useEffect, useRef, useState } from 'preact/hooks'
import { DEFAULT_BLOSSOM, formatBytes, MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, normalizeServer, type FileRef, type Kurultay } from '@kurultay/core'
import { toast } from './store'
import { Icon, Modal } from './ui'

// ------------------------------------------------------------------ outgoing

export interface Pending {
  id: number
  file: File
  status: 'uploading' | 'ready' | 'error'
  ref?: FileRef
  error?: string
  preview?: string
  abort: AbortController
}

let nextId = 1

async function imageSize(file: File) {
  if (!file.type.startsWith('image/') || typeof createImageBitmap !== 'function') return {}
  try {
    const bmp = await createImageBitmap(file)
    const out = { width: bmp.width, height: bmp.height }
    bmp.close()
    return out
  } catch {
    return {}
  }
}

/** Files waiting in the composer. Each starts uploading (encrypted) the moment it is added. */
export function usePendingFiles(e: Kurultay) {
  const [items, setItems] = useState<Pending[]>([])
  const live = useRef(items)
  live.current = items
  const patch = (id: number, p: Partial<Pending>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)))

  const add = (files: File[]) => {
    const room = MAX_FILES_PER_MESSAGE - live.current.length
    if (files.length > room) toast(`At most ${MAX_FILES_PER_MESSAGE} files per message`, 'warn')
    for (const file of files.slice(0, Math.max(0, room))) {
      if (file.size > MAX_FILE_BYTES) {
        toast(`${file.name} is larger than ${formatBytes(MAX_FILE_BYTES)}`, 'warn')
        continue
      }
      const p: Pending = { id: nextId++, file, status: 'uploading', abort: new AbortController(), preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined }
      setItems((xs) => [...xs, p])
      ;(async () => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const ref = await e.uploadFile(bytes, file.name || 'pasted', file.type, { ...(await imageSize(file)), signal: p.abort.signal })
          if (p.abort.signal.aborted) return void e.discardUpload(ref.sha256)
          patch(p.id, { status: 'ready', ref })
        } catch (err) {
          if (!p.abort.signal.aborted) patch(p.id, { status: 'error', error: (err as Error).message })
        }
      })()
    }
  }

  const remove = (id: number) => {
    const p = live.current.find((x) => x.id === id)
    if (!p) return
    p.abort.abort()
    if (p.ref) void e.discardUpload(p.ref.sha256)
    if (p.preview) URL.revokeObjectURL(p.preview)
    setItems((xs) => xs.filter((x) => x.id !== id))
  }

  /** after sending: forget the chips but keep the uploads (they're in the message now) */
  const clear = () => {
    for (const p of live.current) if (p.preview) URL.revokeObjectURL(p.preview)
    setItems([])
  }

  const busy = items.some((x) => x.status === 'uploading')
  const failed = items.some((x) => x.status === 'error')
  const refs = items.filter((x) => x.ref).map((x) => x.ref!)
  return { items, add, remove, clear, busy, failed, refs }
}
export type PendingFiles = ReturnType<typeof usePendingFiles>

export function PendingChips({ pending }: { pending: PendingFiles }) {
  if (!pending.items.length) return null
  return (
    <ul class="pending-files" aria-label="Attachments">
      {pending.items.map((p) => (
        <li key={p.id} class={`pending-file ${p.status}`} title={p.error ?? p.file.name}>
          {p.preview ? <img src={p.preview} alt="" /> : <Icon name="file" size={18} />}
          <span class="pf-name">{p.file.name || 'pasted image'}</span>
          <span class="pf-meta">{p.status === 'uploading' ? 'encrypting & uploading…' : p.status === 'error' ? 'upload failed' : formatBytes(p.file.size)}</span>
          <button class="icon-btn" type="button" onClick={() => pending.remove(p.id)} aria-label={`Remove ${p.file.name}`}>
            <Icon name="x" size={14} />
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Files from a paste or drop event. Pasted screenshots get a readable name. */
export function filesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const files = [...dt.files]
  return files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}${i ? '-' + i : ''}.${(f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`, { type: f.type })))
}

// ------------------------------------------------------------------ incoming

const cache = new Map<string, Promise<string>>()

/** decrypt once per blob and keep an object URL for the session */
function objectUrl(e: Kurultay, ref: FileRef) {
  let p = cache.get(ref.sha256)
  if (!p) {
    p = e.downloadFile(ref).then((bytes) => URL.createObjectURL(new Blob([bytes as BlobPart], { type: ref.mime })))
    p.catch(() => cache.delete(ref.sha256))
    cache.set(ref.sha256, p)
  }
  return p
}

/** Only fetch on sight from servers I trust; anything else waits for a click (a stranger's server learns my IP). */
function trusted(e: Kurultay, ref: FileRef) {
  const mine = new Set([...e.blossom, ...DEFAULT_BLOSSOM].map(normalizeServer))
  return ref.servers.some((s) => mine.has(s))
}

const AUTO_IMAGE_BYTES = 8 * 1024 * 1024
const isImage = (ref: FileRef) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/.test(ref.mime)
const expired = (ref: FileRef) => !!ref.expiresAt && ref.expiresAt < Date.now() / 1000
const host = (ref: FileRef) => ref.servers.map((s) => new URL(s).host).join(', ')

async function save(e: Kurultay, ref: FileRef) {
  try {
    const url = await objectUrl(e, ref)
    const a = document.createElement('a')
    a.href = url
    a.download = ref.name
    document.body.append(a)
    a.click()
    a.remove()
  } catch (err) {
    toast((err as Error).message, 'error')
  }
}

function ImageAttachment({ e, f }: { e: Kurultay; f: FileRef }) {
  const auto = trusted(e, f) && f.size <= AUTO_IMAGE_BYTES && !expired(f)
  const [load, setLoad] = useState(auto)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!load) return
    let on = true
    objectUrl(e, f).then(
      (u) => on && setUrl(u),
      (err) => on && setError((err as Error).message),
    )
    return () => {
      on = false
    }
  }, [load, f.sha256])

  const ratio = f.width && f.height ? `${f.width} / ${f.height}` : undefined
  if (expired(f) && !url) return <FileChip e={e} f={f} />
  if (!load)
    return (
      <button class="att-image placeholder" style={{ aspectRatio: ratio }} onClick={() => setLoad(true)}>
        <Icon name="file" /> Load image · {formatBytes(f.size)} from {host(f)}
      </button>
    )
  return (
    <>
      <button class={`att-image ${url ? '' : 'loading'}`} style={{ aspectRatio: ratio }} onClick={() => url && setOpen(true)} aria-label={`Open ${f.name}`} title={f.name}>
        {url ? <img src={url} alt={f.name} /> : <span class="member-meta">{error ?? 'decrypting…'}</span>}
      </button>
      {open && url && (
        <Modal title={f.name} onClose={() => setOpen(false)} wide>
          <img class="att-full" src={url} alt={f.name} />
          <div class="row end">
            <span class="member-meta">
              {formatBytes(f.size)}
              {f.width ? ` · ${f.width}×${f.height}` : ''}
            </span>
            <button class="btn small" onClick={() => save(e, f)}>
              <Icon name="download" size={16} /> Download
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

function FileChip({ e, f }: { e: Kurultay; f: FileRef }) {
  const [busy, setBusy] = useState(false)
  const gone = expired(f)
  return (
    <div class={`att-file ${gone ? 'expired' : ''}`}>
      <Icon name="file" size={22} />
      <div class="att-file-text">
        <span class="att-name">{f.name}</span>
        <span class="member-meta">
          {formatBytes(f.size)} · {gone ? 'expired' : `encrypted, kept until ${new Date((f.expiresAt ?? 0) * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
        </span>
      </div>
      {!gone && (
        <button class="icon-btn" disabled={busy} onClick={() => (setBusy(true), save(e, f).finally(() => setBusy(false)))} aria-label={`Download ${f.name}`} title={trusted(e, f) ? 'Download' : `Download from ${host(f)}`}>
          <Icon name="download" />
        </button>
      )}
    </div>
  )
}

export function Attachments({ e, files }: { e: Kurultay; files: FileRef[] }) {
  return (
    <div class="attachments">
      {files.map((f) => (isImage(f) ? <ImageAttachment key={f.sha256} e={e} f={f} /> : <FileChip key={f.sha256} e={e} f={f} />))}
    </div>
  )
}
