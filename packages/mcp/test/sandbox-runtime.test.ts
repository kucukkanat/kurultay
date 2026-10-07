// The sandbox runtime without a sandbox: the turn lifecycle, the fallback (D6), the files the daemon and `kurultay __sandbox`
// exchange, and how srt's refusals become what the owner sees. The backends here are real `{ available, wrap }` objects
// (one that cannot run, one that runs commands as they are and reports refusals), not stand-ins for srt. The real srt
// runs in sandbox/srt.integration.test.ts.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SandboxConfig, SandboxViolation } from '@kurultay/core'
import type { HeadlessCommand } from '../src/headless'
import { installPathsFor, installPrefix, mergeViolations, shebangProgram, startTurn, turnBase } from '../src/sandbox'
import { sandboxMain, toViolation, toViolations } from '../src/sandbox/exec'
import { HOST_PROFILES } from '../src/sandbox/hosts'
import type { Policy } from '../src/sandbox/policy'
import { POLICY_FILE, readViolations, runSandboxCommand, seccompHelper, selfEntry, srtBackend, srtConfig, srtWinExe, vendored, VIOLATIONS_FILE, withSeccompHelper, writeViolations, type SandboxBackend, type TurnFile } from '../src/sandbox/srt'

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kurultay-${name}-`)))
const mcpRoot = resolve(import.meta.dir, '..')
const ON: SandboxConfig = { enabled: true, allowDomains: [], readPaths: [], writePaths: [] }
const cmd: HeadlessCommand = { cmd: 'claude', args: ['-p', 'hi'], env: { A: '1' }, outputFile: '/x/out.txt' }

/** A backend that can never run here, the way a Linux box without bubblewrap answers. */
const unavailable = (reason: string): SandboxBackend => ({
  available: async () => ({ ok: false, reason, fix: 'sudo apt-get install bubblewrap' }),
  wrap: () => {
    throw new Error('an unavailable sandbox must never wrap')
  },
})

/** A backend that runs the command as it is, records each wrap, and reports `refused` the way `__sandbox` does: in the turn folder. */
function direct(refused: SandboxViolation[]) {
  const wraps: { cmd: HeadlessCommand; policy: Policy; turnDir: string }[] = []
  const backend: SandboxBackend = {
    available: async () => ({ ok: true }),
    wrap: (c, policy, turnDir) => {
      wraps.push({ cmd: c, policy, turnDir })
      writeViolations(turnDir, refused)
      return c
    },
  }
  return { backend, wraps }
}

describe('startTurn', () => {
  test('no sandbox config, or one switched off: the turn runs exactly as before', async () => {
    for (const config of [undefined, { ...ON, enabled: false }]) {
      const turn = await startTurn({ host: 'claude', mode: 'edit', workdir: '/w', config }, { backend: unavailable('never asked') })
      expect(turn).toMatchObject({ active: false, outDir: tmpdir() })
      expect(turn.fellBack).toBeUndefined()
      expect(turn.promptNote).toBeUndefined()
      expect(turn.wrap(cmd)).toBe(cmd)
      expect(turn.finish()).toEqual({ violations: [] })
    }
  })

  test('D6: a sandbox that cannot run lets the agent answer unsandboxed, and says why', async () => {
    const turn = await startTurn({ host: 'claude', mode: 'edit', workdir: '/w', config: ON }, { backend: unavailable('missing bwrap') })
    expect(turn).toMatchObject({ active: false, fellBack: 'missing bwrap' })
    expect(turn.promptNote).toBeUndefined()
    expect(turn.wrap(cmd)).toBe(cmd)
  })

  test('a CLI without a sandbox profile falls back too, rather than running with a guessed one', async () => {
    const turn = await startTurn({ host: 'not-a-cli', mode: 'edit', workdir: '/w', config: ON }, { backend: direct([]).backend })
    expect(turn.active).toBe(false)
    expect(turn.fellBack).toContain('not-a-cli')
  })

  test('a sandboxed turn: its own short folder, the policy for its mode, the prompt line, and clean-up', async () => {
    const home = tmp('sbx-home')
    const workdir = tmp('sbx-work')
    const configRoot = join(home, '.config', 'kurultay')
    const refused: SandboxViolation[] = [{ kind: 'read', target: join(home, '.ssh', 'id_ed25519'), at: 2 }, { kind: 'network', target: 'example.com', at: 3 }]
    const b = direct(refused)
    const turn = await startTurn({ host: 'claude', mode: 'edit', workdir, config: { ...ON, allowDomains: ['docs.example.com'] } }, { backend: b.backend, home, configRoot })
    expect(turn.active).toBe(true)
    expect(turn.fellBack).toBeUndefined()
    // the CLI's output file goes where the sandbox lets it write: a fresh folder, by its real path (macOS /tmp is a symlink)
    expect(turn.outDir.startsWith(realpathSync(turnBase()))).toBe(true)
    // srt's proxy socket goes in here: with its name (srt-mux-<pid>-<n>.sock) the path must stay under the 104-byte limit
    expect(join(turn.outDir, 'srt-mux-4194304-10.sock').length).toBeLessThanOrEqual(104)
    expect(turn.promptNote).toContain(workdir)
    expect(turn.promptNote).toContain('docs.example.com')

    const wrapped = turn.wrap(cmd)
    const [w] = b.wraps
    if (!w) throw new Error('not wrapped')
    expect(w.turnDir).toBe(turn.outDir)
    // the CLI's own arguments are only adjusted where its inner sandbox cannot nest
    expect(w.cmd.args).toEqual(HOST_PROFILES.claude?.nested?.(cmd.args) ?? cmd.args)
    expect(wrapped).toEqual(w.cmd)
    expect(w.policy.denyRead).toContain(home)
    expect(w.policy.allowWrite).toContain(workdir)
    expect(w.policy.allowWrite).toContain(turn.outDir)
    expect(w.policy.allowedDomains).toContain('docs.example.com')

    expect(turn.finish()).toEqual({ violations: refused })
    expect(existsSync(turn.outDir)).toBe(false)
  })
})

describe('the re-entry', () => {
  test('wrap writes the config and the argv for `kurultay __sandbox`, and re-enters the code that is running', () => {
    const turnDir = tmp('sbx-turn')
    const policy: Policy = { allowRead: ['/r'], denyRead: ['/home'], allowWrite: ['/w'], denyWrite: ['/home/.config/kurultay'], allowedDomains: ['api.example.com'], allowMachLookup: ['com.apple.SecurityServer'], env: { DISABLE_TELEMETRY: '1', A: 'policy wins' } }
    const hostile = `it's $(rm -rf ~) \`x\` ! "q"\n`
    const r = srtBackend.wrap({ ...cmd, args: ['-p', hostile] }, policy, turnDir)
    // from source the entry is src/cli.ts, run by this same runtime
    expect(selfEntry()).toBe(join(mcpRoot, 'src', 'cli.ts'))
    expect(r).toEqual({ cmd: process.execPath, args: [selfEntry(), '__sandbox', turnDir], env: { A: 'policy wins', DISABLE_TELEMETRY: '1', CLAUDE_CODE_TMPDIR: turnDir }, outputFile: '/x/out.txt' })
    const file = JSON.parse(readFileSync(join(turnDir, POLICY_FILE), 'utf8')) as TurnFile
    // the prompt is data in a JSON file, never part of a command line we build
    expect(file.argv).toEqual(['claude', '-p', hostile])
    expect(file.config).toEqual(srtConfig(policy, turnDir))
  })

  test('the srt config carries the policy, keeps every socket closed, and write-protects the files the turn exchanges', () => {
    const policy: Policy = { allowRead: ['/r'], denyRead: ['/h'], allowWrite: ['/w'], denyWrite: ['/d'], allowedDomains: ['a.com'], allowMachLookup: ['m'], env: {} }
    expect(srtConfig(policy, '/t')).toEqual({
      network: { allowedDomains: ['a.com'], deniedDomains: [], allowUnixSockets: [], allowLocalBinding: true, allowMachLookup: ['m'] },
      filesystem: { denyRead: ['/h'], allowRead: ['/r'], allowWrite: ['/w'], denyWrite: ['/d', join('/t', POLICY_FILE), join('/t', VIOLATIONS_FILE)] },
    })
  })

  test('violations round-trip; none written means none known; a broken file is an error', () => {
    const dir = tmp('sbx-v')
    expect(readViolations(dir)).toEqual([])
    const vs: SandboxViolation[] = [{ kind: 'write', target: '/x', at: 5 }]
    writeViolations(dir, vs)
    expect(readViolations(dir)).toEqual(vs)
    writeFileSync(join(dir, VIOLATIONS_FILE), '[{"kind":"bogus"}]')
    expect(() => readViolations(dir)).toThrow('not a list of violations')
  })

  test('a symlink planted in the turn folder is replaced, never written through', () => {
    const dir = tmp('sbx-link')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'keep me')
    symlinkSync(victim, join(dir, VIOLATIONS_FILE))
    writeViolations(dir, [])
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
    expect(readViolations(dir)).toEqual([])
  })

  test('`kurultay __sandbox` without a turn folder, or with a broken one, fails loud', async () => {
    await expect(sandboxMain([])).rejects.toThrow('usage')
    const dir = tmp('sbx-bad')
    writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ config: {}, argv: [] }))
    await expect(sandboxMain([dir])).rejects.toThrow('has no command')
    writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ argv: ['true'] }))
    await expect(sandboxMain([dir])).rejects.toThrow('has no config')
    writeFileSync(join(dir, POLICY_FILE), JSON.stringify({ config: { network: {} }, argv: ['true'] }))
    await expect(sandboxMain([dir])).rejects.toThrow('invalid policy')
  })
})

describe('what the owner sees', () => {
  const at = new Date(1000)
  const v = (line: string) => toViolation({ line, timestamp: at })
  test('Seatbelt, proxy and seccomp lines become kinds and targets; sockets have nothing to allow', () => {
    expect(v('cat(1) deny(1) file-read-data /Users/me/.ssh/id')).toEqual({ kind: 'read', target: '/Users/me/.ssh/id', at: 1000 })
    expect(v('bash(2) deny(1) file-write-create /Users/me/x y.txt')).toEqual({ kind: 'write', target: '/Users/me/x y.txt', at: 1000 })
    expect(v('node(3) deny(1) network-outbound /private/var/run/docker.sock')).toEqual({ kind: 'other', target: 'network-outbound /private/var/run/docker.sock', at: 1000 })
    expect(v('node(3) deny(1) network-outbound 1.2.3.4:53')).toEqual({ kind: 'network', target: '1.2.3.4:53', at: 1000 })
    expect(v('node(3) deny(1) network-outbound')).toEqual({ kind: 'other', target: 'network-outbound', at: 1000 })
    expect(v('claude(4) deny(1) mach-lookup com.apple.SecurityServer')).toEqual({ kind: 'other', target: 'mach-lookup com.apple.SecurityServer', at: 1000 })
    expect(v('deny network-outbound evil.example:443 (host is not on the allow list)')).toEqual({ kind: 'network', target: 'evil.example', at: 1000 })
    expect(v('deny network-outbound evil.example:8443 (host is not on the allow list)')).toEqual({ kind: 'network', target: 'evil.example:8443', at: 1000 })
    expect(v('deny openat /home/me/.bashrc')).toEqual({ kind: 'write', target: '/home/me/.bashrc', at: 1000 })
    expect(v('deny connect /run/user/1000/ssh-agent.sock')).toEqual({ kind: 'other', target: 'connect /run/user/1000/ssh-agent.sock', at: 1000 })
    expect(v('something new')).toEqual({ kind: 'other', target: 'something new', at: 1000 })
  })

  test('what every process trips over is left out, and repeats are one entry', () => {
    expect(v('bash(1) deny(1) sysctl-read kern.iossupportversion')).toBeUndefined()
    expect(v('curl(1) deny(1) system-info vfs.disk-space')).toBeUndefined()
    const line = 'cat(1) deny(1) file-read-data /secret'
    expect(toViolations([{ line, timestamp: at }, { line, timestamp: new Date(2000) }, { line: 'x(1) deny(1) sysctl-read k', timestamp: at }])).toEqual([{ kind: 'read', target: '/secret', at: 1000 }])
  })
})

describe('mergeViolations', () => {
  const v = (target: string, at: number, kind: SandboxViolation['kind'] = 'network'): SandboxViolation => ({ kind, target, at })
  test('keeps what earlier turns hit, one entry per target, newest sighting first', () => {
    expect(mergeViolations([v('a.com', 1), v('b.com', 2)], [v('a.com', 5)], 20)).toEqual([v('a.com', 5), v('b.com', 2)])
  })
  test('the same target of a different kind is its own entry, and the list is capped', () => {
    expect(mergeViolations([v('/x', 1, 'read')], [v('/x', 2, 'write'), v('c.com', 3)], 2)).toEqual([v('c.com', 3), v('/x', 2, 'write')])
  })
  test('a clean turn changes nothing', () => {
    expect(mergeViolations([v('a.com', 1)], [], 20)).toEqual([v('a.com', 1)])
  })
})

describe('install paths', () => {
  test('a script inside node_modules opens all of it (hoisted and sibling packages); anything else its own folder', () => {
    expect(installPrefix('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')).toBe('/opt/homebrew/lib/node_modules')
    expect(installPrefix('/home/me/.bun/install/global/node_modules/@github/copilot/index.js')).toBe('/home/me/.bun/install/global/node_modules')
    expect(installPrefix('/home/me/.local/share/claude/versions/2.1.0/claude')).toBe('/home/me/.local/share/claude/versions/2.1.0')
  })

  test('the interpreter is read from the shebang', () => {
    expect(shebangProgram('#!/usr/bin/env node')).toBe('node')
    expect(shebangProgram('#!/usr/bin/env -S node --no-warnings')).toBe('node')
    expect(shebangProgram('#!/usr/local/bin/bun')).toBe('/usr/local/bin/bun')
    expect(shebangProgram('\x7fELF\x02')).toBeUndefined()
  })

  test('a real CLI on PATH resolves to its install and its interpreter, never to a folder holding the home folder', () => {
    const dir = tmp('sbx-bin')
    const pkg = join(dir, 'lib', 'node_modules', 'fake-cli', 'bin')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'cli.js'), '#!/usr/bin/env sh\necho hi\n', { mode: 0o755 })
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    symlinkSync(join(pkg, 'cli.js'), join(bin, 'fake-cli'))
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    const paths = installPathsFor('fake-cli', '/nonexistent-home', env)
    expect(paths).toContain(join(bin, 'fake-cli'))
    expect(paths).toContain(join(dir, 'lib', 'node_modules'))
    expect(paths.some((p) => /\/(sh|bash|dash)$/.test(p))).toBe(true)
    expect(installPathsFor('no-such-cli-anywhere', '/nonexistent-home', env)).toEqual([])
    for (const p of installPathsFor('fake-cli', dir, env)) expect(p === dir || dir.startsWith(p + '/')).toBe(false)
  })
})

describe('this machine', () => {
  test('availability is asked once and kept briefly (every turn asks)', async () => {
    const first = srtBackend.available()
    expect(srtBackend.available()).toBe(first)
    const a = await first
    if (!a.ok) expect(a.reason.length).toBeGreaterThan(0)
  })

  test('`kurultay sandbox status` says what the daemon would see; anything else prints the usage', async () => {
    const a = await srtBackend.available()
    expect(await runSandboxCommand(['status'])).toBe(a.ok ? 0 : 1)
    expect(await runSandboxCommand(['bogus'])).toBe(1)
    expect(await runSandboxCommand([])).toBe(1)
  })

  test("from source the helpers are srt's own copies, not a vendor/ folder", async () => {
    expect(vendored('seccomp')).toBeUndefined()
    expect(await srtWinExe()).toContain(join('vendor', 'srt-win'))
    expect(seccompHelper()).toMatch(/vendor\/seccomp\/(x64|arm64)\/apply-seccomp$/)
  })

  test('on Linux the seccomp helper is set and re-opened for reading, since it lives in a denied folder; elsewhere nothing changes', () => {
    const config = srtConfig({ allowRead: ['/w'], denyRead: ['/home/u'], allowWrite: [], denyWrite: [], allowedDomains: [], allowMachLookup: [], env: {} }, '/t')
    const helper = '/home/u/.config/kurultay/bin/vendor/seccomp/x64/apply-seccomp'
    const out = withSeccompHelper(config, 'linux', helper)
    expect(out.seccomp?.applyPath).toBe(helper)
    expect(out.filesystem.allowRead).toEqual(['/w', helper])
    expect(withSeccompHelper(config, 'darwin', '/x')).toBe(config)
    expect(withSeccompHelper(config, 'linux', undefined)).toBe(config)
  })
})
