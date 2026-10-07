import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_AGENT_MODE, Kurultay, now, pickPlayfulName, type AgentTicket, type State } from '@kurultay/core'
import { configRoot, displayName, FileStorage } from './instance'
import { saveKey } from './keystore'
import { installFor, type Host } from './install'

/** Seating agents from a ticket: shared by `kurultay join` and the daemon's `/seat` (the web app). */

export const LABEL: Record<Host, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot CLI',
  pi: 'pi',
  opencode: 'opencode',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  vscode: 'VS Code',
}

export type SeatErrorCode = 'bad-workdir' | 'bad-ticket' | 'no-hosts' | 'paused' | 'unknown-agent'

/** A request the owner can fix (the app shows the message as is). */
export class SeatError extends Error {
  constructor(
    readonly code: SeatErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface Prepared {
  host: Host
  instance: string
  name: string
  dir: string
  sk: Uint8Array
  pubkey: string
  busy: boolean
}

/** Write the ticket identity + pending joins for one host into its instance slot (#1). */
export function prepare(ticket: AgentTicket, host: Host): Prepared {
  const instance = `${host}#1`
  const dir = join(configRoot(), 'instances', instance)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'state.json')
  const lock = join(dir, 'lock')
  const busy = existsSync(lock) && alive(Number(readFileSync(lock, 'utf8').trim()))
  let existing: State | null = null
  try {
    existing = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}
  const { sk, pubkey, state } = Kurultay.fromTicket(ticket, host, existing)
  if (existing && existing.inbox !== state.inbox) renameSync(file, `${file}.bak-${Date.now()}`)
  saveKey(instance, dir, sk)
  state.pk = pubkey
  // Only a fresh identity gets a playful name: reseating, or an agent seated before names existed, is never renamed.
  if (!state.agentSettings?.name && (!existing || existing.inbox !== state.inbox))
    state.agentSettings = { mode: state.agentSettings?.mode ?? DEFAULT_AGENT_MODE, name: pickPlayfulName(namesInUse()), updatedAt: now() }
  new FileStorage(file).save(state)
  return { host, instance, name: state.agentSettings?.name ?? displayName(instance), dir, sk, pubkey, busy }
}

/** Names of the agents already on this machine, so two hosts seated by one command never share a handle. */
function namesInUse(): string[] {
  const root = join(configRoot(), 'instances')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((d) => {
    try {
      const name: unknown = JSON.parse(readFileSync(join(root, d, 'state.json'), 'utf8')).agentSettings?.name
      return typeof name === 'string' ? [name] : []
    } catch {
      // A missing or broken neighbour state must not block seating; it simply reserves no name.
      return []
    }
  })
}

/** An existing folder, by its real path (macOS tmp folders are symlinks, and the registry should hold one name). */
export function workdirOf(path: string): string {
  let dir: string
  try {
    dir = realpathSync(resolve(path))
  } catch {
    throw new SeatError('bad-workdir', `${path} does not exist`)
  }
  if (!statSync(dir).isDirectory()) throw new SeatError('bad-workdir', `${dir} is not a folder`)
  return dir
}

/**
 * The local copy agent CLIs and the service run (`join` places it). From source (tests, `bun src/cli.ts`) there is none,
 * and installFor falls back to the npx command.
 */
export function installedRuntime(): string | undefined {
  const self = fileURLToPath(import.meta.url)
  if (!/\.m?js$/.test(self)) return undefined
  const installed = join(configRoot(), 'bin', 'kurultay.mjs')
  return existsSync(installed) ? installed : self
}

export interface Seated {
  prepared: Prepared
  steps: ReturnType<typeof installFor>
}

/** Give every host its ticket identity and point its CLI at Kurultay (replacing a plugin install, so one server runs). */
export const seatAgents = (ticket: AgentTicket, hosts: readonly Host[], runtime: string | undefined): Seated[] =>
  hosts.map((host) => ({ prepared: prepare(ticket, host), steps: installFor(host, { runtime, replacePlugin: true }) }))
