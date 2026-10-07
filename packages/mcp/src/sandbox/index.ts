import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import type { AgentMode, SandboxConfig, SandboxViolation } from '@kurultay/core'
import { headlessCommand, type HeadlessCommand } from '../headless'
import { configRoot as defaultConfigRoot } from '../instance'
import { HOST_PROFILES } from './hosts'
import { policyFor, promptNoteFor, within } from './policy'
import { readViolations, srtBackend, type SandboxBackend } from './srt'

/** The sandbox as the daemon sees it: `startTurn` around each background turn (docs/sandbox.md, "The seam"). */

export { validateGrants } from './policy'
export { srtBackend, type SandboxBackend } from './srt'

export interface TurnInput {
  host: string
  mode: AgentMode
  workdir: string
  /** the agent's registry entry; absent or disabled → the turn runs exactly as before */
  config?: SandboxConfig
}

/** One background turn, as the daemon sees it. */
export interface SandboxTurn {
  /** the turn is actually sandboxed (false when disabled, or when it fell back) */
  readonly active: boolean
  /** the one line for the background prompt (D18); undefined unless active */
  readonly promptNote?: string
  /** the sandbox was wanted but could not run, and why (D6); the daemon tells the owner and the council */
  readonly fellBack?: string
  /** a folder for the CLI's output file that the sandbox lets it write (os.tmpdir() when not sandboxed) */
  readonly outDir: string
  wrap(cmd: HeadlessCommand): HeadlessCommand
  /** after the command exited: what was refused; removes the turn folder */
  finish(): { violations: SandboxViolation[] }
}

export interface TurnDeps {
  backend?: SandboxBackend
  home?: string
  configRoot?: string
}

/**
 * Where turn folders go. srt puts its proxy socket in the turn folder, and a Unix socket path may be at most 104 bytes:
 * macOS's os.tmpdir() (/var/folders/…/T/) leaves too little room, so POSIX systems use /tmp.
 */
export const turnBase = (): string => (process.platform === 'win32' ? tmpdir() : '/tmp')

const inactive = (fellBack?: string): SandboxTurn => ({ active: false, fellBack, outDir: tmpdir(), wrap: (cmd) => cmd, finish: () => ({ violations: [] }) })

const which = (bin: string, env: NodeJS.ProcessEnv): string | undefined => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', env })
  return (r.status === 0 && r.stdout.split(/\r?\n/)[0]?.trim()) || undefined
}

/**
 * The folder a program is installed in. Inside a `node_modules`, all of it: package managers hoist dependencies beside the
 * package (bun's global install), and codex loads its native binary from a sibling package. Else the program's own folder.
 */
export function installPrefix(file: string): string {
  const parts = file.split(sep)
  const nm = parts.lastIndexOf('node_modules')
  return nm >= 0 && nm < parts.length - 1 ? parts.slice(0, nm + 1).join(sep) : dirname(file)
}

/** `#!/usr/bin/env node` → `node`, `#!/usr/local/bin/node` → that path; undefined when the file is not a script. */
export function shebangProgram(head: string): string | undefined {
  const m = /^#!\s*(\S+)(?:\s+(?:-S\s+)?(\S+))?/.exec(head)
  if (!m?.[1]) return undefined
  return basename(m[1]) === 'env' ? m[2] : m[1]
}

const firstLine = (file: string): string => {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(256)
    return buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('latin1').split('\n')[0] ?? ''
  } finally {
    closeSync(fd)
  }
}

/** An interpreter's prefix: `<prefix>/bin/node` → `<prefix>` (its lib/ comes along), unless that would open a whole home or ~/.local. */
const interpreterPrefix = (file: string, home: string): string => {
  const dir = dirname(file)
  const up = dirname(dir)
  return basename(dir) === 'bin' && up !== home && up !== join(home, '.local') ? up : dir
}

/**
 * Where an agent CLI and the interpreter running it are installed, by real location (macOS tmp folders and npm bins are
 * symlinks, and the sandbox judges real paths). Both the link and its target are listed: running the link reads both.
 */
export function installPathsFor(bin: string, home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const found = which(bin, env)
  if (!found) return []
  const real = realpathSync(found)
  const program = shebangProgram(firstLine(real))
  const interp = program && (program.startsWith('/') ? program : which(program, env))
  const paths = [found, installPrefix(real), ...(interp ? [interp, interpreterPrefix(realpathSync(interp), home)] : [])]
  // allowRead wins over denyRead in srt: a prefix that holds the home folder (`/bin/sh` → `/`) would open all of it
  return [...new Set(paths)].filter((p) => !within(home, p))
}

/** Wrap one background turn. Inactive when off; inactive with `fellBack` when wanted but impossible (D6). */
export async function startTurn(input: TurnInput, deps: TurnDeps = {}): Promise<SandboxTurn> {
  if (!input.config?.enabled) return inactive()
  const backend = deps.backend ?? srtBackend
  const availability = await backend.available()
  if (!availability.ok) return inactive(availability.reason)
  const profile = HOST_PROFILES[input.host]
  if (!profile) return inactive(`no sandbox profile for ${input.host}`)

  const home = deps.home ?? homedir()
  const configRoot = deps.configRoot ?? defaultConfigRoot()
  // real paths: the sandbox compares the paths the kernel reports, and macOS's tmp folder is a symlink into /private
  const turnDir = realpathSync(mkdtempSync(join(turnBase(), 'kurultay-')))
  const workdir = realpathSync(input.workdir)
  const bin = headlessCommand(input.host, input.mode, '', workdir, '')?.cmd
  const installPaths = bin ? installPathsFor(bin, home) : []
  const policy = policyFor({ mode: input.mode, workdir, turnDir, home, installPaths, profile, grants: input.config, configRoot })
  return {
    active: true,
    promptNote: promptNoteFor({ workdir, grants: input.config, domains: policy.allowedDomains, mode: input.mode }),
    outDir: turnDir,
    wrap: (cmd) => backend.wrap(profile.nested ? { ...cmd, args: profile.nested(cmd.args) } : cmd, policy, turnDir),
    finish() {
      try {
        return { violations: readViolations(turnDir) }
      } finally {
        rmSync(turnDir, { recursive: true, force: true })
      }
    },
  }
}

/** One entry per kind and target, the newest sighting wins, newest first, at most `cap`. Pure. */
export function mergeViolations(old: readonly SandboxViolation[], fresh: readonly SandboxViolation[], cap: number): SandboxViolation[] {
  const byTarget = new Map([...old, ...fresh].sort((a, b) => a.at - b.at).map((v) => [`${v.kind}\0${v.target}`, v]))
  return [...byTarget.values()].sort((a, b) => b.at - a.at).slice(0, cap)
}
