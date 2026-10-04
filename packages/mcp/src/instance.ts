import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { State, Storage } from '@kurultay/core'

export function configRoot() {
  if (process.env.KURULTAY_HOME) return process.env.KURULTAY_HOME
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdg, 'kurultay')
}

function alive(pid: number) {
  if (!pid || pid === process.pid) return pid === process.pid
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function sanitize(name: string) {
  return (name || 'agent').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent'
}

export interface Instance {
  name: string
  dir: string
  release(): void
}

/**
 * Each running MCP server claims one persistent identity slot: `<client>#1`, `<client>#2`, …
 * Two concurrent sessions of the same host get two distinct agents; a restarted session
 * reuses the first free slot (and with it the same key and group memberships).
 */
export function claimInstance(base: string): Instance {
  const root = join(configRoot(), 'instances')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const fixed = process.env.KURULTAY_INSTANCE
  const candidates = fixed ? [sanitize(fixed).replace(/-(\d+)$/, '#$1')] : Array.from({ length: 64 }, (_, i) => `${sanitize(base)}#${i + 1}`)
  for (const name of candidates) {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lock = join(dir, 'lock')
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, 'utf8').trim())
      if (alive(pid) && !fixed) continue
    }
    writeFileSync(lock, String(process.pid))
    const release = () => {
      try {
        if (readFileSync(lock, 'utf8').trim() === String(process.pid)) unlinkSync(lock)
      } catch {}
    }
    return { name, dir, release }
  }
  throw new Error('No free Kurultay instance slot')
}

export class FileStorage implements Storage {
  constructor(private file: string) {}
  load(): State | null {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return null
    }
  }
  save(state: State) {
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch {}
  }
}
