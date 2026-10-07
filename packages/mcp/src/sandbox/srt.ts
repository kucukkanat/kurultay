import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SandboxAvailability, SandboxViolation } from '@kurultay/core'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { HeadlessCommand } from '../headless'
import type { Policy } from './policy'

/**
 * The srt backend (Anthropic's sandbox-runtime). srt is a per-process singleton (one proxy pair, one config), and the
 * daemon runs several agents with different allowlists at once, so the daemon never loads it: `wrap` writes the turn's
 * config and the agent's argv to `<turnDir>/policy.json` and re-enters this bundle as `kurultay __sandbox <turnDir>`
 * (exec.ts), one process per turn. The library is imported lazily, so the MCP server every agent CLI starts never loads it.
 */

export const POLICY_FILE = 'policy.json'
export const VIOLATIONS_FILE = 'violations.json'

/** A sandbox backend as the daemon uses it. Tests pass their own real implementation; there is no interface hierarchy. */
export interface SandboxBackend {
  available(): Promise<SandboxAvailability>
  /** the command that runs `cmd` under `policy`; may write what it needs into `turnDir` */
  wrap(cmd: HeadlessCommand, policy: Policy, turnDir: string): HeadlessCommand
}

/** What `kurultay __sandbox` reads. The argv never passes through a shell we build: exec.ts quotes it with srt's own quoter. */
export interface TurnFile {
  config: SandboxRuntimeConfig
  argv: string[]
}

const here = fileURLToPath(import.meta.url)
/** Built: dist/cli.js or ~/.config/kurultay/bin/kurultay.mjs. From source: src/sandbox/srt.ts, which Bun runs as it is. */
const bundled = /\.m?js$/.test(here)

/** The running code, to re-enter: the bundle when built, src/cli.ts from source. */
export const selfEntry = (): string => (bundled ? here : join(dirname(here), '..', 'cli.ts'))

/**
 * srt's helper programs (the Linux seccomp filter, the Windows srt-win.exe) are files, not code: the build copies them to
 * `vendor/` beside the bundle and `join` carries them along. From source they are undefined and srt finds its own copy.
 */
export function vendored(...rel: string[]): string | undefined {
  if (!bundled) return undefined
  const p = join(dirname(here), 'vendor', ...rel)
  return existsSync(p) ? p : undefined
}

const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'

/** srt's Linux seccomp helper for this machine: beside the bundle when installed, else the package's own copy. */
export function seccompHelper(): string | undefined {
  if (bundled) return vendored('seccomp', ARCH, 'apply-seccomp')
  const pkg = join(dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/sandbox-runtime'))), '..')
  const own = join(pkg, 'vendor', 'seccomp', ARCH, 'apply-seccomp')
  return existsSync(own) ? own : undefined
}

/**
 * The turn's config with its seccomp helper set. Pure. The helper runs inside the sandbox from a folder the policy denies
 * (the installed bundle sits in the Kurultay config folder), so that one public file is re-opened for reading.
 */
export function withSeccompHelper(config: SandboxRuntimeConfig, platform: NodeJS.Platform, helper: string | undefined): SandboxRuntimeConfig {
  if (platform !== 'linux' || !helper) return config
  return { ...config, seccomp: { ...config.seccomp, applyPath: helper }, filesystem: { ...config.filesystem, allowRead: [...(config.filesystem.allowRead ?? []), helper] } }
}

/** Where srt-win.exe is: beside the bundle, or the package's own copy from source. */
export async function srtWinExe(): Promise<string> {
  return vendored('srt-win', ARCH, 'srt-win.exe') ?? (await import('@anthropic-ai/sandbox-runtime')).VENDORED_SRT_WIN_EXE
}

/** Policy → srt's config. Pure. The turn's own files are write-protected so the agent can't plant a symlink exec.ts follows. */
export const srtConfig = (policy: Policy, turnDir: string): SandboxRuntimeConfig => ({
  network: {
    allowedDomains: [...policy.allowedDomains],
    deniedDomains: [],
    // every Unix socket stays closed (ssh-agent, docker, the daemon's own socket); there is no grant for them
    allowUnixSockets: [],
    // the agent may reach servers it starts itself, so a Full agent can test its own dev server (accepted risk on macOS)
    allowLocalBinding: true,
    allowMachLookup: [...policy.allowMachLookup],
  },
  filesystem: {
    denyRead: [...policy.denyRead],
    allowRead: [...policy.allowRead],
    allowWrite: [...policy.allowWrite],
    denyWrite: [...policy.denyWrite, join(turnDir, POLICY_FILE), join(turnDir, VIOLATIONS_FILE)],
  },
})

/**
 * Through a temp file and a rename: a rename replaces a planted symlink instead of writing through it. The turn folder is
 * the agent's to write, so the temp file is created, never opened: a random name it cannot guess, and `wx` (O_EXCL),
 * which refuses any existing name, a symlink included, instead of writing through it into a file the owner can write.
 */
export function writeViolations(turnDir: string, violations: readonly SandboxViolation[]) {
  const tmp = join(turnDir, `.${VIOLATIONS_FILE}.${randomUUID()}`)
  writeFileSync(tmp, JSON.stringify(violations), { mode: 0o600, flag: 'wx' })
  renameSync(tmp, join(turnDir, VIOLATIONS_FILE))
}

const KINDS: readonly string[] = ['read', 'write', 'network', 'other'] satisfies SandboxViolation['kind'][]
const isViolation = (v: unknown): v is SandboxViolation =>
  typeof v === 'object' && v !== null && 'kind' in v && 'target' in v && 'at' in v && KINDS.includes(String(v.kind)) && typeof v.target === 'string' && typeof v.at === 'number'

/** No file means `__sandbox` never got to the end (killed, or a backend that reports nothing): nothing is known, not an error. */
export function readViolations(turnDir: string): SandboxViolation[] {
  const file = join(turnDir, VIOLATIONS_FILE)
  if (!existsSync(file)) return []
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(raw) || !raw.every(isViolation)) throw new Error(`sandbox: ${file} is not a list of violations`)
  return raw
}

const onPath = (bin: string) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0

/** The install command for the missing Linux tools (the binaries are bwrap and rg, the packages bubblewrap and ripgrep). */
function linuxInstallFix(missing: readonly string[]): string {
  const pkgs = missing.map((b) => (b === 'bwrap' ? 'bubblewrap' : b === 'rg' ? 'ripgrep' : b)).join(' ')
  if (onPath('apt-get')) return `sudo apt-get install ${pkgs}`
  if (onPath('dnf')) return `sudo dnf install ${pkgs}`
  if (onPath('pacman')) return `sudo pacman -S ${pkgs}`
  return `install ${pkgs} with your package manager`
}

/** Ubuntu 24.04 lets AppArmor refuse unprivileged user namespaces, which bubblewrap needs: ask bwrap itself. */
const userNamespacesWork = (): boolean =>
  spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-net', '--unshare-pid', 'true'], { stdio: 'ignore', timeout: 10_000 }).status === 0

async function check(): Promise<SandboxAvailability> {
  if (process.platform === 'darwin') return existsSync('/usr/bin/sandbox-exec') ? { ok: true } : { ok: false, reason: 'this Mac has no sandbox-exec' }
  if (process.platform === 'linux') {
    const missing = ['bwrap', 'socat', 'rg'].filter((b) => !onPath(b))
    if (missing.length) return { ok: false, reason: `missing ${missing.join(', ')}`, fix: linuxInstallFix(missing) }
    if (!userNamespacesWork()) return { ok: false, reason: 'this system does not allow unprivileged user namespaces', fix: 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0' }
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
    const deps = await SandboxManager.checkDependenciesAsync()
    if (deps.errors.length) return { ok: false, reason: deps.errors.join('; ') }
    // without its seccomp helper srt only warns and leaves Unix sockets open, which we promise are closed
    if (deps.warnings.some((w) => w.includes('seccomp')) || !seccompHelper()) return { ok: false, reason: 'the sandbox helper files are missing; run the “Add your agents” command again to reinstall' }
    return { ok: true }
  }
  if (process.platform === 'win32') {
    const srt = await import('@anthropic-ai/sandbox-runtime')
    const exe = await srtWinExe()
    if (!existsSync(exe)) return { ok: false, reason: `the sandbox helper is missing (${exe})` }
    const deps = await srt.checkWindowsDependenciesAsync({ srtWin: srt.resolveSrtWin({ path: exe }) })
    return deps.errors.length ? { ok: false, reason: deps.errors.join('; '), fix: 'kurultay sandbox setup' } : { ok: true }
  }
  return { ok: false, reason: `sandboxes are not supported on ${process.platform}` }
}

// A check spawns processes (bwrap, srt-win) and every turn asks: keep the answer long enough to cover a burst of turns,
// short enough that installing the missing package is noticed without restarting the daemon.
const CACHE_MS = 60_000
let cached: { at: number; value: Promise<SandboxAvailability> } | undefined

export const srtBackend: SandboxBackend = {
  available() {
    if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), value: check() }
    return cached.value
  },
  // CLAUDE_CODE_TMPDIR: srt points the sandbox's TMPDIR there (and keeps its proxy socket there), so each turn gets a
  // private temp folder instead of the shared /tmp/claude
  wrap(cmd, policy, turnDir) {
    const file: TurnFile = { config: srtConfig(policy, turnDir), argv: [cmd.cmd, ...cmd.args] }
    writeFileSync(join(turnDir, POLICY_FILE), JSON.stringify(file), { mode: 0o600 })
    return { cmd: process.execPath, args: [selfEntry(), '__sandbox', turnDir], env: { ...cmd.env, ...policy.env, CLAUDE_CODE_TMPDIR: turnDir }, outputFile: cmd.outputFile }
  },
}

const describe = (a: SandboxAvailability) => (a.ok ? 'Sandboxes are ready on this machine.' : `Sandboxes can't run here: ${a.reason}.${a.fix ? `\nTo fix it, run:\n  ${a.fix}` : ''}`)

async function confirm(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

/** `kurultay sandbox status|setup [--yes]`. Only Windows has something to set up (one admin prompt); elsewhere it says what to install. */
export async function runSandboxCommand(argv: readonly string[]): Promise<number> {
  const [sub] = argv
  if (sub !== 'status' && sub !== 'setup') {
    console.error('Usage: kurultay sandbox status | kurultay sandbox setup [--yes]')
    return 1
  }
  const now = await srtBackend.available()
  if (sub === 'status' || now.ok || process.platform !== 'win32') {
    console.log(describe(now))
    return now.ok ? 0 : 1
  }
  if (!argv.includes('--yes') && !argv.includes('-y')) {
    if (!process.stdin.isTTY) {
      console.error('Setting up sandboxes needs one administrator prompt. Run again with --yes to go ahead.')
      return 1
    }
    console.log('This adds a separate Windows user that sandboxed agents run as, and firewall rules for it. Windows asks once for administrator rights.')
    if (!(await confirm('Set up sandboxes?'))) return 1
  }
  const srt = await import('@anthropic-ai/sandbox-runtime')
  const result = await srt.installWindowsSandboxAsync({ srtWin: srt.resolveSrtWin({ path: await srtWinExe() }) })
  if (result.cancelled) {
    console.error('Cancelled at the administrator prompt. Nothing changed.')
    return 2
  }
  cached = undefined
  const after = await srtBackend.available()
  console.log(describe(after))
  return after.ok ? 0 : 1
}
