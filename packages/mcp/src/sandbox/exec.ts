import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { join } from 'node:path'
import type { SandboxViolation } from '@kurultay/core'
import type { SandboxViolationEvent } from '@anthropic-ai/sandbox-runtime'
import { POLICY_FILE, seccompHelper, srtWinExe, withSeccompHelper, writeViolations, type TurnFile } from './srt'

/**
 * `kurultay __sandbox <turnDir>`: one background turn inside srt, in its own process (srt holds one config per process).
 * stdout and stderr are the daemon's own pipes, handed straight to the agent CLI: the answer is read from stdout byte for
 * byte. The exit code is the CLI's.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// macOS reports file refusals through `log stream`, which flushes late; srt gives no signal for it, so after the command
// we wait until no new refusal arrived for QUIET_MS (at most FLUSH_CAP_MS). Reporting is best-effort; enforcement is not.
const QUIET_MS = 300
const FLUSH_CAP_MS = 2000

function readTurnFile(turnDir: string): TurnFile {
  const raw: unknown = JSON.parse(readFileSync(join(turnDir, POLICY_FILE), 'utf8'))
  if (typeof raw !== 'object' || raw === null) throw new Error(`sandbox: ${POLICY_FILE} is not an object`)
  const argv: unknown = 'argv' in raw ? raw.argv : undefined
  const config: unknown = 'config' in raw ? raw.config : undefined
  if (!Array.isArray(argv) || !argv.length || !argv.every((a): a is string => typeof a === 'string')) throw new Error(`sandbox: ${POLICY_FILE} has no command`)
  if (typeof config !== 'object' || config === null) throw new Error(`sandbox: ${POLICY_FILE} has no config`)
  // the shape is checked by srt's own schema in runSandboxed before anything reads it
  return { config: config as TurnFile['config'], argv }
}

// Seatbelt lines look like `cat(123) deny(1) file-read-data /path`; the proxy's `deny network-outbound host:443 (why)`;
// Linux's seccomp observer `deny openat /path` (it only reports writes: a denied read just finds an empty folder)
const SEATBELT = /deny\(\d+\) (\S+)(?: (.+))?$/
const PROXY = /^deny network-outbound (\S+) \(/
const SECCOMP = /^deny (\S+) (\/.*)$/
// macOS asks these of every process; refusing them is harmless and would bury what matters
const NOISE = /^(sysctl-read|system-info|file-read-metadata|iokit|ipc-posix|process-info)/

/** One srt line → what the owner sees. Pure. */
export function toViolation(e: SandboxViolationEvent): SandboxViolation | undefined {
  const at = e.timestamp.getTime()
  const proxy = PROXY.exec(e.line)
  // the default ports say nothing to the owner, and the Allow button allows a host
  if (proxy?.[1]) return { kind: 'network', target: proxy[1].replace(/:(443|80)$/, ''), at }
  const sb = SEATBELT.exec(e.line)
  if (sb?.[1]) {
    const [, op, target] = sb
    if (NOISE.test(op)) return undefined
    // seatbelt sometimes names no target (a dual-stack loopback connect): only the operation is known
    if (!target) return { kind: 'other', target: op, at }
    if (op.startsWith('file-read')) return { kind: 'read', target, at }
    if (op.startsWith('file-write')) return { kind: 'write', target, at }
    // a path here is a Unix socket: closed for good, so it is "other", with nothing to allow
    if (op.startsWith('network') && !target.startsWith('/')) return { kind: 'network', target, at }
    return { kind: 'other', target: `${op} ${target}`, at }
  }
  const sc = SECCOMP.exec(e.line)
  if (sc?.[1] && sc[2]) return sc[1] === 'connect' ? { kind: 'other', target: `connect ${sc[2]}`, at } : { kind: 'write', target: sc[2], at }
  return { kind: 'other', target: e.line, at }
}

/** One entry per kind and target: a CLI retrying a read a hundred times is one refusal. Pure. */
export function toViolations(events: readonly SandboxViolationEvent[]): SandboxViolation[] {
  const seen = new Map<string, SandboxViolation>()
  for (const v of events.map(toViolation)) if (v && !seen.has(`${v.kind}\0${v.target}`)) seen.set(`${v.kind}\0${v.target}`, v)
  return [...seen.values()]
}

/** Resolves once no refusal arrived for QUIET_MS (or after FLUSH_CAP_MS): the late tail of macOS's log stream. */
async function quiet(store: { getCount(): number }): Promise<void> {
  let count = store.getCount()
  let since = Date.now()
  for (const end = Date.now() + FLUSH_CAP_MS; Date.now() < end && Date.now() - since < QUIET_MS; await sleep(50)) {
    if (store.getCount() !== count) [count, since] = [store.getCount(), Date.now()]
  }
}

const exitCode = (code: number | null, signal: NodeJS.Signals | null) => code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)

/** The CLI entry: `kurultay __sandbox <turnDir>`. Fails loud on a missing or broken turn file. */
export async function sandboxMain(args: readonly string[]): Promise<number> {
  const [turnDir] = args
  if (!turnDir) throw new Error('usage: kurultay __sandbox <turnDir>')
  const turn = readTurnFile(turnDir)
  const srt = await import('@anthropic-ai/sandbox-runtime')
  // srt's quoter, not the shell-quote package: that one turns `!` into `\!` inside double quotes, and our argv is
  // council-written text. Single quotes keep every byte literal (the integration test's hostile prompt guards this).
  const { quote } = await import('@anthropic-ai/sandbox-runtime/dist/utils/shell-quote.js')
  const { SandboxManager } = srt
  const base = process.platform === 'win32' && !turn.config.windows?.srtWin ? { ...turn.config, windows: { ...turn.config.windows, srtWin: { path: await srtWinExe() } } } : turn.config
  // validated before anything reads it: a broken policy must fail as one, not as a TypeError further in
  const parsed = srt.SandboxRuntimeConfigSchema.safeParse(base)
  if (!parsed.success) throw new Error(`sandbox: invalid policy: ${parsed.error.message}`)

  // the daemon stops a turn with SIGTERM (then SIGKILL): pass it on, and don't start a CLI that was already cancelled
  let child: ChildProcess | undefined
  let stopped: NodeJS.Signals | undefined
  const forward = (sig: NodeJS.Signals) => () => {
    stopped = sig
    child?.kill(sig)
  }
  process.on('SIGTERM', forward('SIGTERM'))
  process.on('SIGINT', forward('SIGINT'))

  await SandboxManager.initialize(withSeccompHelper(parsed.data, process.platform, process.platform === 'linux' ? seccompHelper() : undefined), undefined, true)
  try {
    if (stopped) return exitCode(null, stopped)
    const command = quote(turn.argv)
    if (process.platform === 'win32') {
      const { argv, env } = await SandboxManager.wrapWithSandboxArgv(command)
      const [exe, ...rest] = argv
      if (!exe) throw new Error('sandbox: srt returned an empty command')
      child = spawn(exe, rest, { shell: false, stdio: 'inherit', env })
    } else child = spawn(await SandboxManager.wrapWithSandbox(command), { shell: true, stdio: 'inherit' })
    const started = child
    const code = await new Promise<number>((resolve, reject) => {
      started.on('error', reject)
      started.on('exit', (c, s) => resolve(exitCode(c, s)))
    })
    if (process.platform === 'darwin') await quiet(SandboxManager.getSandboxViolationStore())
    // bwrap leaves empty mount-point files on the host for deny paths that did not exist; srt removes them here
    SandboxManager.cleanupAfterCommand()
    writeViolations(turnDir, toViolations(SandboxManager.getSandboxViolationStore().getViolations()))
    return code
  } finally {
    await SandboxManager.reset()
  }
}
