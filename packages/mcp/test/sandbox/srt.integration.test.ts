// Real sandboxes, no stand-ins: srt wraps a real agent process through the real `kurultay __sandbox` re-entry, from source
// and from a built bundle installed by `join` (with its vendor/ helpers). Needs sandbox-exec (macOS) or bwrap, socat and
// rg (Linux); skipped, with the reason, where the sandbox cannot run.
import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Kurultay, MemoryStorage, newSecretKey, type SandboxViolation } from '@kurultay/core'
import type { HeadlessCommand } from '../../src/headless'
import { OutputFileError, readOutputFile } from '../../src/sandbox'
import { HOST_PROFILES } from '../../src/sandbox/hosts'
import { policyFor } from '../../src/sandbox/policy'
import { readViolations, srtBackend } from '../../src/sandbox/srt'

const mcpRoot = resolve(import.meta.dir, '../..')
const linux = process.platform === 'linux'
const avail = await srtBackend.available()
if (!avail.ok) console.warn(`skipping the sandbox integration test: ${avail.reason}${avail.fix ? ` (fix: ${avail.fix})` : ''}`)

// council-written text: every shell metacharacter, a newline, a lone `!` (the shell-quote package turns it into `\!`), unicode
const HOSTILE = [
  `it's "quoted" and \`ticked\` $(touch /tmp/kurultay-pwned) \${HOME} ; rm -rf ~ && echo | cat > /dev/null`,
  'line one\nline two\r\n\ttabbed',
  '!',
  'if (!x) { echo $((1+1)) }',
  "'",
  '"',
  '',
  ' leading and trailing ',
  '--help',
  '*',
  '~',
  'back\\slash \\n',
  'ünïcödé 🎉 中文',
]

interface Outcome {
  ok: boolean
  value?: unknown
  status?: number
  body?: string
}
type Report = Record<'readSecret' | 'readWorkdir' | 'writeWorkdir' | 'writeOutside' | 'writeConfig' | 'allowed' | 'denied' | 'deniedDomain', Outcome> & { argv: string[] }

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kurultay-${name}-`)))
const serve = (body: string) => {
  const s = Bun.serve({ port: 0, fetch: () => new Response(body) })
  if (s.port === undefined) throw new Error('the test server has no port')
  return { port: s.port, stop: () => void s.stop(true) }
}
const ok = serve('allowed-body')
const no = serve('denied-body')
afterAll(() => {
  ok.stop()
  no.stop()
})

/** A home holding a secret and a Kurultay config folder, a working folder, a turn folder and an "installed" agent. */
function layout(home = join(tmp('sbx'), 'home')) {
  const root = dirname(home)
  const dirs = { home, workdir: join(root, 'work'), turnDir: tmp('turn'), configRoot: join(home, '.config', 'kurultay'), agent: join(root, 'agent') }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  copyFileSync(join(import.meta.dir, 'fixture-agent.mjs'), join(dirs.agent, 'agent.mjs'))
  writeFileSync(join(dirs.workdir, 'in.txt'), 'hello')
  writeFileSync(join(home, 'secret.txt'), 'the owner’s secret')
  const plan = {
    secret: join(home, 'secret.txt'),
    workdirFile: join(dirs.workdir, 'in.txt'),
    workdirOut: join(dirs.workdir, 'out.txt'),
    outside: join(root, 'outside.txt'),
    configFile: join(dirs.configRoot, 'agents.json'),
    allowedUrl: `http://localhost:${ok.port}/`,
    deniedUrl: `http://localhost:${no.port}/`,
    deniedDomainUrl: 'https://example.com/',
  }
  writeFileSync(join(dirs.workdir, 'plan.json'), JSON.stringify(plan))
  return { ...dirs, plan }
}
type Layout = ReturnType<typeof layout>

/** The policy an Edit agent gets, with grants that try (and must fail) to open the config folder. */
const policyIn = (l: Layout) =>
  policyFor({
    mode: 'edit',
    workdir: l.workdir,
    turnDir: l.turnDir,
    home: l.home,
    installPaths: [dirname(realpathSync(process.execPath)), l.agent],
    // only a profile names a local server: an owner's grant can never allow one
    profile: { readPaths: [], writePaths: [], domains: [`localhost:${ok.port}`] },
    grants: { allowDomains: [], readPaths: [l.configRoot], writePaths: [l.configRoot] },
    configRoot: l.configRoot,
  })

const agentCmd = (l: Layout): HeadlessCommand => ({ cmd: process.execPath, args: [join(l.agent, 'agent.mjs'), join(l.workdir, 'plan.json'), ...HOSTILE] })

async function run(cmd: HeadlessCommand, cwd: string) {
  const p = Bun.spawn([cmd.cmd, ...cmd.args], { cwd, env: { ...process.env, ...cmd.env }, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { stdout, stderr, code }
}

function expectContained(r: { stdout: string; stderr: string; code: number }, l: Layout, violations: SandboxViolation[]) {
  expect(r.stderr).toBe('')
  expect(r.code).toBe(0)
  // stdout is the agent's own, untouched: the daemon reads the answer from it
  expect(r.stdout.trimEnd().split('\n')).toHaveLength(1)
  const report = JSON.parse(r.stdout) as Report
  // the shell-injection guard: every argument arrives byte for byte, and nothing in it ran
  expect(report.argv).toEqual(HOSTILE)
  expect(existsSync('/tmp/kurultay-pwned')).toBe(false)

  expect(report.readSecret.ok).toBe(false)
  expect(report.readWorkdir).toEqual({ ok: true, value: 'hello' })
  expect(report.writeWorkdir.ok).toBe(true)
  expect(readFileSync(l.plan.workdirOut, 'utf8')).toBe('written')
  expect(report.writeOutside.ok).toBe(false)
  expect(existsSync(l.plan.outside)).toBe(false)
  // granted on purpose, refused anyway. Linux hides a read-denied folder behind an empty in-memory one, so the write
  // "succeeds" there and is thrown away; what matters everywhere is that the real folder is untouched
  if (!linux) expect(report.writeConfig.ok).toBe(false)
  expect(existsSync(l.plan.configFile)).toBe(false)

  expect(report.allowed).toMatchObject({ ok: true, status: 200, body: 'allowed-body' })
  expect(report.denied).toMatchObject({ ok: false, status: 403 })
  expect(report.deniedDomain.ok).toBe(false)
  // proxy refusals are recorded by srt itself and are reliable; macOS file reports are best-effort, so not required
  expect(violations.some((v) => v.kind === 'network' && v.target === 'example.com')).toBe(true)
  expect(violations.some((v) => v.kind === 'network' && v.target === `localhost:${no.port}`)).toBe(true)
  expect(violations.some((v) => v.target.includes(`:${ok.port}`) || v.target.startsWith(l.workdir))).toBe(false)
}

describe.skipIf(!avail.ok)('a sandboxed turn', () => {
  test('from source: keeps to its working folder and allowed sites, and the prompt arrives byte for byte', async () => {
    const l = layout()
    const wrapped = srtBackend.wrap(agentCmd(l), policyIn(l), l.turnDir)
    // the re-entry: this runtime running the CLI's own entry, nothing in between
    expect(wrapped.cmd).toBe(process.execPath)
    expect(wrapped.args).toEqual([join(mcpRoot, 'src', 'cli.ts'), '__sandbox', l.turnDir])
    expectContained(await run(wrapped, l.workdir), l, readViolations(l.turnDir))
  }, 60_000)

  test('a stopped turn stops the agent: SIGTERM is passed on', async () => {
    const l = layout()
    const wrapped = srtBackend.wrap({ cmd: '/bin/sh', args: ['-c', 'trap "echo stopped; exit 7" TERM; echo ready; while :; do sleep 0.1; done'] }, policyIn(l), l.turnDir)
    const p = Bun.spawn([wrapped.cmd, ...wrapped.args], { cwd: l.workdir, env: { ...process.env, ...wrapped.env }, stdout: 'pipe', stderr: 'pipe' })
    const reader = p.stdout.getReader()
    let out = ''
    while (!out.includes('ready')) {
      const { value, done } = await reader.read()
      if (done) break
      out += new TextDecoder().decode(value)
    }
    p.kill('SIGTERM')
    const code = await p.exited
    // Seatbelt runs the agent in the same process chain, so it sees the signal; bubblewrap stands between them on Linux
    // and takes the agent down with it: the turn still ends, which is what the daemon needs
    if (linux) expect(code).not.toBe(0)
    else expect(code).toBe(7)
  }, 60_000)

  test('the files the daemon reads back cannot be turned against it, and the CLIs\' code-running config stays read-only', async () => {
    const l = layout()
    const victim = join(dirname(l.home), 'victim.json')
    writeFileSync(victim, '{"keep":true}')
    const claude = HOST_PROFILES.claude
    const codex = HOST_PROFILES.codex
    if (!claude || !codex) throw new Error('missing host profiles')
    // the real profiles' files in this home, holding what the owner put there
    const guarded = ['.claude/settings.json', '.claude/hooks/on-stop.sh', '.codex/config.toml'].map((f) => join(l.home, f))
    for (const f of guarded) {
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f, 'the owner’s')
    }
    // Talk: the narrowest mode still writes the turn folder and the CLIs' own state, which is what the attack needs
    const policy = policyFor({
      mode: 'talk',
      workdir: l.workdir,
      turnDir: l.turnDir,
      home: l.home,
      installPaths: [],
      profile: { readPaths: [], writePaths: [...claude.writePaths, ...codex.writePaths], denyWrite: [...(claude.denyWrite ?? []), ...(codex.denyWrite ?? [])], domains: [] },
      grants: { allowDomains: [], readPaths: [], writePaths: [] },
      configRoot: l.configRoot,
    })
    // what a prompt-injected agent tries: its output file and a hard link become the owner's key, a link waits under the
    // violations temp name of each recent pid (the `__sandbox` process among them), and it edits the CLIs' hooks and config
    const script = [
      'T="$1"; H="$2"; S="$3"; V="$4"',
      'ln -s "$S" "$T/out.txt"',
      'ln "$S" "$T/hard.txt" 2>/dev/null',
      // ps is refused inside the sandbox, but pids are handed out in order: the ones just below the agent's own
      'i=1; while [ $i -le 32 ]; do ln -sf "$V" "$T/.violations.json.$(($$ - i))" 2>/dev/null; i=$((i + 1)); done',
      'for f in .claude/settings.json .claude/hooks/on-stop.sh .codex/config.toml .claude/settings.local.json .codex/rules/allow.rules; do (echo pwned > "$H/$f") 2>/dev/null; done',
      'mv "$H/.claude" "$H/.claude-moved" 2>/dev/null',
      'echo state > "$H/.claude/state.txt"',
      'echo done',
    ].join('\n')
    const wrapped = srtBackend.wrap({ cmd: '/bin/sh', args: ['-c', script, 'sh', l.turnDir, l.home, l.plan.secret, victim] }, policy, l.turnDir)
    const r = await run(wrapped, l.workdir)
    expect(r.stdout.trim()).toBe('done')
    expect(r.code).toBe(0)

    // the output file is a link to the secret: the daemon refuses it instead of posting the key to the council
    expect(lstatSync(join(l.turnDir, 'out.txt')).isSymbolicLink()).toBe(true)
    expect(() => readOutputFile(join(l.turnDir, 'out.txt'))).toThrow(OutputFileError)
    // a hard link is refused by the sandbox or by the daemon; either way the secret never comes back
    if (existsSync(join(l.turnDir, 'hard.txt'))) expect(() => readOutputFile(join(l.turnDir, 'hard.txt'))).toThrow(OutputFileError)
    // the unsandboxed `__sandbox` process wrote its report through no planted link
    expect(readFileSync(victim, 'utf8')).toBe('{"keep":true}')
    expect(Array.isArray(readViolations(l.turnDir))).toBe(true)
    // hooks and config are untouched, and none was added beside them; the CLI's own state stays writable
    for (const f of guarded) expect(readFileSync(f, 'utf8')).toBe('the owner’s')
    expect(existsSync(join(l.home, '.claude/settings.local.json'))).toBe(false)
    expect(existsSync(join(l.home, '.codex/rules/allow.rules'))).toBe(false)
    expect(existsSync(join(l.home, '.claude-moved'))).toBe(false)
    expect(readFileSync(join(l.home, '.claude/state.txt'), 'utf8')).toBe('state\n')
  }, 60_000)

  test('from a built bundle installed by `join`: the helpers come along and the turn runs the same', async () => {
    const node = Bun.which('node')
    if (!node) throw new Error('node is needed to run the built bundle')
    const out = tmp('bundle')
    const build = Bun.spawnSync(['bun', 'scripts/build.ts', out], { cwd: mcpRoot, stderr: 'pipe' })
    expect(build.exitCode).toBe(0)

    // install the way an owner does, into a throwaway home: `join` copies the bundle and its vendor/ beside it
    const l = layout()
    const fakeBin = tmp('fake-bin')
    writeFileSync(join(fakeBin, 'codex'), '#!/bin/sh\nexit 0\n')
    chmodSync(join(fakeBin, 'codex'), 0o755)
    const owner = new Kurultay({ sk: newSecretKey(), name: 'tolga', kind: 'human', relays: [], storage: new MemoryStorage() })
    const env = { ...process.env, HOME: l.home, KURULTAY_HOME: l.configRoot, KURULTAY_NO_KEYCHAIN: '1', PATH: `${fakeBin}:${process.env.PATH}` }
    const join_ = Bun.spawnSync([node, join(out, 'cli.js'), 'join', owner.createTicket([], { hosts: ['codex'] }), '--host', 'codex', '--no-background', '--no-wait'], { env, cwd: l.workdir, stdout: 'pipe', stderr: 'pipe' })
    expect(join_.stderr.toString()).toBe('')
    expect(join_.exitCode).toBe(0)
    const bin = join(l.configRoot, 'bin')
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    expect(existsSync(join(bin, 'kurultay.mjs'))).toBe(true)
    expect(existsSync(join(bin, 'vendor', 'seccomp', arch, 'apply-seccomp'))).toBe(true)
    expect(existsSync(join(bin, 'vendor', 'srt-win', arch, 'srt-win.exe'))).toBe(true)

    // the real layout: the bundle and its helpers live inside the config folder the policy always denies
    const wrapped = srtBackend.wrap(agentCmd(l), policyIn(l), l.turnDir)
    const r = await run({ ...wrapped, cmd: node, args: [join(bin, 'kurultay.mjs'), ...wrapped.args.slice(1)] }, l.workdir)
    expectContained(r, l, readViolations(l.turnDir))
  }, 180_000)
})

describe.if(linux)('when the sandbox cannot run', () => {
  test('a machine without bubblewrap is reported with the command that fixes it', () => {
    // a real process with a PATH that has no bwrap: the same check the daemon makes before each turn
    const code = `import { srtBackend } from ${JSON.stringify(join(mcpRoot, 'src/sandbox/srt.ts'))}; console.log(JSON.stringify(await srtBackend.available()))`
    const r = Bun.spawnSync([process.execPath, '-e', code], { env: { ...process.env, PATH: dirname(process.execPath) }, stdout: 'pipe', stderr: 'pipe' })
    const result = JSON.parse(r.stdout.toString())
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('bwrap')
  })
})
