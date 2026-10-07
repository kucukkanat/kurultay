import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { AgentMode, SandboxGrants } from '@kurultay/core'

/**
 * The pure half of the sandbox: which paths and hosts one background turn may reach, and which grants the owner may
 * never make. Nothing here touches srt. Design and decisions: docs/sandbox.md.
 */

/** What one agent CLI needs to run at all. Paths may start with `~/`; `policyFor` expands them. */
export interface HostProfile {
  /** config and state the CLI only reads */
  readonly readPaths: readonly string[]
  /** config, state, caches and credentials the CLI writes (also readable) */
  readonly writePaths: readonly string[]
  /**
   * Inside `writePaths`, what stays read-only: the CLI's own settings, hooks, plugins, MCP servers and instructions. These
   * run code (or steer the model) the next time the owner uses the CLI outside the sandbox, so writing them would let a
   * prompt-injected turn escape its sandbox later.
   */
  readonly denyWrite?: readonly string[]
  /** model and login endpoints; telemetry and update hosts are left out on purpose (D17) */
  readonly domains: readonly string[]
  /** macOS services the CLI must look up, e.g. the Keychain (`com.apple.SecurityServer`) */
  readonly machLookup?: readonly string[]
  /** environment set only when sandboxed: telemetry and auto-update opt-outs */
  readonly env?: Readonly<Record<string, string>>
  /** adjust the CLI's arguments when its own sandbox cannot nest inside ours; identity otherwise */
  readonly nested?: (args: readonly string[], on: NestedContext) => string[]
}

/** What a `nested` rewrite may depend on: whether the CLI's own sandbox can start here, and whether the mode needs it to. */
export interface NestedContext {
  readonly mode: AgentMode
  readonly platform: NodeJS.Platform
}

/** The resolved rules for one turn. Absolute paths only. */
export interface Policy {
  readonly allowRead: readonly string[]
  readonly denyRead: readonly string[]
  readonly allowWrite: readonly string[]
  readonly denyWrite: readonly string[]
  readonly allowedDomains: readonly string[]
  readonly allowMachLookup: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface PolicyInput {
  readonly mode: AgentMode
  /** absolute, already resolved */
  readonly workdir: string
  /** a fresh per-turn folder: the only place outside the CLI's own state that every mode may write */
  readonly turnDir: string
  readonly home: string
  /** where the CLI and its interpreter are installed, readable in every mode */
  readonly installPaths: readonly string[]
  readonly profile: HostProfile
  readonly grants: SandboxGrants
  /** stays closed whatever is granted: agent keys, the registry holding this very config, the daemon socket */
  readonly configRoot: string
}

/** Why a grant was refused; the app shows it next to the field. */
export interface GrantError {
  readonly field: keyof SandboxGrants
  readonly value: string
  readonly reason: string
}

export type GrantCheck = { ok: true; grants: SandboxGrants } | { ok: false; errors: GrantError[] }

export interface ProtectedContext {
  readonly home: string
  readonly configRoot: string
}

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)]

/** `inner` is `outer` or sits inside it (whole segments: `/ab` is not inside `/a`). */
export const within = (inner: string, outer: string): boolean => {
  const r = relative(outer, inner)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}

/** Either path opens the other: a grant inside a protected folder, or one that contains it, both expose it. */
export const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a)

/** Other tools' credential stores. `~/.config/gh` sits beside our config root, so `~/.config` is refused too. */
export const CREDENTIAL_DIRS = ['.ssh', '.gnupg', '.aws', '.config/gh', '.kube', '.docker'] as const

/** Why this path can never be granted, or undefined when it may be. Pure: callers pass absolute, resolved paths. */
export function pathProblem(path: string, { home, configRoot }: ProtectedContext): string | undefined {
  if (path === parse(path).root) return 'the whole disk can never be opened'
  if (within(home, path)) return 'your whole home folder can never be opened'
  // the config root holds agent keys and the registry with this sandbox config: opening it lets an agent free itself
  if (overlaps(path, configRoot)) return "Kurultay's own settings can never be opened"
  const store = CREDENTIAL_DIRS.find((d) => overlaps(path, join(home, d)))
  return store === undefined ? undefined : `~/${store} holds credentials and can never be opened`
}

/** `~/x` → `<home>/x`, normalised. Undefined for a relative path: it would silently depend on the daemon's cwd. */
export const expand = (path: string, home: string): string | undefined => {
  const p = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path
  return isAbsolute(p) ? resolve(p) : undefined
}

/** Profile, install and turn paths come from our own code: a relative one is a bug, so it fails loud. */
const absolute = (path: string, home: string): string => {
  const p = expand(path, home)
  if (p === undefined) throw new Error(`sandbox: ${path} is not an absolute path`)
  return p
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const HOST = new RegExp(`^(\\*\\.)?((?:${LABEL}\\.)*${LABEL})(?::(\\d{1,5}))?$`)
const LOOPBACK = /^(localhost|.*\.localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/

export const normaliseDomain = (domain: string): string => domain.trim().toLowerCase()

/** Why a (normalised) domain cannot be allowed, or undefined. */
export function domainProblem(domain: string): string | undefined {
  const m = HOST.exec(domain)
  if (!m) return 'must be a host name like example.com, *.example.com or example.com:8443, without https:// or a path'
  const [, wildcard, host = '', port] = m
  if (wildcard && !host.includes('.')) return 'a wildcard needs a domain under it, like *.example.com'
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return 'the port must be from 1 to 65535'
  // loopback would open every local service, the daemon's own control port included
  if (LOOPBACK.test(host)) return 'programs on this computer can never be allowed'
  return undefined
}

/** How far each mode reaches into the working folder and granted paths; the Record keeps it exhaustive. */
const REACH: Record<AgentMode, { read: boolean; write: boolean }> = {
  off: { read: false, write: false },
  talk: { read: false, write: false },
  read: { read: true, write: false },
  edit: { read: true, write: true },
  full: { read: true, write: true },
}

/** The rules for one turn. Pure. Grants are filtered again here, so one that slipped past validation still opens nothing protected. */
export function policyFor(input: PolicyInput): Policy {
  const { profile, grants } = input
  const home = resolve(input.home)
  const configRoot = resolve(input.configRoot)
  const reach = REACH[input.mode]
  const own = (paths: readonly string[]) => paths.map((p) => absolute(p, home))
  const granted = (paths: readonly string[]) =>
    paths.flatMap((p) => {
      const e = expand(p, home)
      return e !== undefined && pathProblem(e, { home, configRoot }) === undefined ? [e] : []
    })
  const workdir = absolute(input.workdir, home)
  const turnDir = absolute(input.turnDir, home)
  // srt lets allowRead win over denyRead, so nothing touching the config root may be allowed, whatever its source
  const open = (paths: readonly string[]) => unique(paths).filter((p) => !overlaps(p, configRoot))
  return {
    allowRead: open([
      ...own(profile.readPaths),
      ...own(profile.writePaths),
      ...own(input.installPaths),
      turnDir,
      ...(reach.read ? [workdir, ...granted(grants.readPaths), ...granted(grants.writePaths)] : []),
    ]),
    denyRead: unique([home, configRoot]),
    allowWrite: open([...own(profile.writePaths), turnDir, ...(reach.write ? [workdir, ...granted(grants.writePaths)] : [])]),
    denyWrite: unique([configRoot, ...own(profile.denyWrite ?? [])]),
    allowedDomains: unique([...profile.domains, ...grants.allowDomains.map(normaliseDomain).filter((d) => domainProblem(d) === undefined)]),
    allowMachLookup: unique(profile.machLookup ?? []),
    env: { ...profile.env },
  }
}

const isMissing = (e: unknown): boolean => e instanceof Error && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')

/** realpath, through the nearest existing ancestor for a path that does not exist yet. */
const real = (path: string): string => {
  try {
    return realpathSync.native(path)
  } catch (e) {
    if (!isMissing(e)) throw e
    const parent = dirname(path)
    return parent === path ? path : join(real(parent), basename(path))
  }
}

/** A symlink must not smuggle a protected path in, so the typed path and where it really leads are both checked. */
const realProblem = (path: string, ctx: ProtectedContext): string | undefined => {
  try {
    const realCtx = { home: real(ctx.home), configRoot: real(ctx.configRoot) }
    return pathProblem(path, ctx) ?? pathProblem(real(path), realCtx) ?? pathProblem(path, realCtx) ?? pathProblem(real(path), ctx)
  } catch (e) {
    return `cannot be checked: ${e instanceof Error ? e.message : String(e)}`
  }
}

type Fixed = { value: string } | { reason: string }
const fixed = (value: string, reason: string | undefined): Fixed => (reason === undefined ? { value } : { reason })
const isString = (x: unknown): x is string => typeof x === 'string'
const FIELDS: Record<keyof SandboxGrants, string> = { allowDomains: 'websites', readPaths: 'paths', writePaths: 'paths' }

/** Check an untrusted grants body from the web app. Every problem is reported, so the app can mark every field at once. */
export function validateGrants(raw: unknown, ctx: ProtectedContext): GrantCheck {
  const body: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {}
  const errors: GrantError[] = []
  const check = (field: keyof SandboxGrants, fix: (x: string) => Fixed): string[] => {
    const v = body[field]
    if (!Array.isArray(v) || !v.every(isString)) {
      errors.push({ field, value: String(JSON.stringify(v)).slice(0, 80), reason: `must be a list of ${FIELDS[field]}` })
      return []
    }
    return unique(
      v.flatMap((x) => {
        const r = fix(x)
        if ('value' in r) return [r.value]
        errors.push({ field, value: x, reason: r.reason })
        return []
      }),
    )
  }
  const path = (raw: string): Fixed => {
    const p = expand(raw.trim(), ctx.home)
    return p === undefined ? { reason: 'must be a full path, starting with / or ~/' } : fixed(p, realProblem(p, ctx))
  }
  const grants: SandboxGrants = {
    allowDomains: check('allowDomains', (d) => fixed(normaliseDomain(d), domainProblem(normaliseDomain(d)))),
    readPaths: check('readPaths', path),
    writePaths: check('writePaths', path),
  }
  return errors.length ? { ok: false, errors } : { ok: true, grants }
}

/** The one line the background prompt gets when the turn is sandboxed (D18). */
export function promptNoteFor({ workdir, grants, domains, mode }: { workdir: string; grants: SandboxGrants; domains: readonly string[]; mode: AgentMode }): string {
  const folders = unique([...grants.readPaths, ...grants.writePaths])
  const extra = folders.length ? `, and these granted folders: ${folders.join(', ')},` : ''
  const sites = domains.length ? `these websites: ${unique(domains).join(', ')}` : 'no websites'
  // talk and off open no folder at all: promising one would only waste the agent's attempts
  const reach = REACH[mode].read ? `you can reach your working folder (${workdir})${extra} and` : 'you have no file access and can reach'
  return `You run in a sandbox: ${reach} ${sites}. Anything else is blocked; if something you need is blocked, say so instead of retrying.`
}
