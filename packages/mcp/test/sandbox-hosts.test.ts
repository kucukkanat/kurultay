import { describe, expect, test } from 'bun:test'
import { EMPTY_SANDBOX_GRANTS, type AgentMode } from '@kurultay/core'
import { HEADLESS_HOSTS, headlessCommand } from '../src/headless'
import { HOST_PROFILES } from '../src/sandbox/hosts'
import { domainProblem, expand, pathProblem, policyFor } from '../src/sandbox/policy'


const MODES: readonly AgentMode[] = ['off', 'talk', 'read', 'edit', 'full']
const home = '/Users/someone'
const ctx = { home, configRoot: `${home}/.config/kurultay` }

/** Telemetry, analytics and update hosts seen in the spike or named in the CLIs' docs: D17 keeps them out of every profile. */
const TELEMETRY_HOSTS = [
  'statsig.anthropic.com',
  'http-intake.logs.datadoghq.com',
  'sentry.io',
  'storage.googleapis.com', // Claude's native updater
  'ab.chatgpt.com', // codex analytics
  'telemetry.enterprise.githubcopilot.com',
  'telemetry.individual.githubcopilot.com',
  'cafe.github.com',
  'pi.dev', // pi's version check
  'play.googleapis.com', // gemini's Clearcut usage statistics
  'registry.npmjs.org',
]

/** Whether an allowed domain (possibly `*.x`) lets `host` through. */
const covers = (domain: string, host: string): boolean =>
  domain.startsWith('*.') ? host.endsWith(domain.slice(1)) : domain.split(':')[0] === host

// every listed profile is defined; the index type allows undefined only so lookups by an unknown host are checked
const entries = Object.entries(HOST_PROFILES).flatMap(([h, p]) => (p ? [[h, p] as const] : []))

describe('host profiles', () => {
  test('every headless host has a profile, and nothing else does', () => {
    expect(Object.keys(HOST_PROFILES).sort()).toEqual([...HEADLESS_HOSTS].sort())
  })

  test.each(entries)('%s: paths are ~/-relative or absolute, and never home, Kurultay or another tool’s credentials', (_, p) => {
    for (const path of [...p.readPaths, ...p.writePaths, ...(p.denyWrite ?? [])]) {
      expect(path.startsWith('~/') || path.startsWith('/')).toBe(true)
      expect(path).not.toContain('..')
      const abs = expand(path, home)
      expect(abs).toBeDefined()
      expect(abs === undefined ? 'unexpanded' : pathProblem(abs, ctx)).toBeUndefined()
    }
  })

  test.each(entries)('%s: what runs code stays read-only, and each such path sits inside a folder the CLI may write', (host, p) => {
    // every CLI that keeps config in its writable state has some: hooks, MCP servers, plugins or extensions
    expect(p.denyWrite?.length).toBeGreaterThan(0)
    for (const d of p.denyWrite ?? []) expect(p.writePaths.some((w) => d.startsWith(`${w}/`))).toBe(true)
    const policy = policyFor({ mode: 'full', workdir: '/work', turnDir: '/tmp/t', home, installPaths: [], profile: p, grants: EMPTY_SANDBOX_GRANTS, configRoot: ctx.configRoot })
    for (const d of p.denyWrite ?? []) expect(policy.denyWrite).toContain(expand(d, home) ?? 'unexpanded')
    expect(policy.denyWrite).toContain(ctx.configRoot)
    if (host === 'claude') for (const f of ['settings.json', 'hooks', 'plugins']) expect(policy.denyWrite).toContain(`${home}/.claude/${f}`)
    if (host === 'codex') expect(policy.denyWrite).toContain(`${home}/.codex/config.toml`)
  })

  test.each(entries)('%s: domains are well formed and let no telemetry or update host through', (_, p) => {
    expect(p.domains.length).toBeGreaterThan(0)
    for (const d of p.domains) {
      expect(domainProblem(d)).toBeUndefined()
      for (const t of TELEMETRY_HOSTS) expect(covers(d, t)).toBe(false)
    }
  })

  test.each(entries)('%s: mach services are reverse-DNS names and env values are strings', (_, p) => {
    for (const m of p.machLookup ?? []) expect(m).toMatch(/^com\.apple\.[A-Za-z.]+$/)
    for (const v of Object.values(p.env ?? {})) expect(typeof v).toBe('string')
  })

  test('the covers helper sees through wildcards', () => {
    expect(covers('*.githubcopilot.com', 'telemetry.enterprise.githubcopilot.com')).toBe(true)
    expect(covers('api.githubcopilot.com', 'telemetry.enterprise.githubcopilot.com')).toBe(false)
  })
})

/** The flags a `nested` may touch: codex's `--sandbox <v>`, cursor's `--sandbox disabled`, Claude's `--settings {"sandbox":…}`. */
const withoutSandboxFlags = (args: readonly string[]): string[] =>
  args.filter((a, i) => !(a === '--sandbox' || args[i - 1] === '--sandbox' || (a === '--settings' && args[i + 1]?.includes('"sandbox"')) || (args[i - 1] === '--settings' && a.includes('"sandbox"'))))

describe('nested', () => {
  const nestedHosts = entries.filter(([, p]) => p.nested)

  test('the CLIs whose own sandbox cannot nest have one', () => {
    expect(nestedHosts.map(([h]) => h).sort()).toEqual(['claude', 'codex', 'cursor'])
  })

  // codex on macOS outside Talk is the one rewrite that depends on where and how it runs; the others always apply
  const mac = { mode: 'edit', platform: 'darwin' } as const
  for (const [host, p] of nestedHosts) {
    const nested = p.nested
    if (!nested) continue
    test.each([...MODES])(`${host} (%s): pure, and changes only the sandbox flag`, (mode: AgentMode) => {
      const cmd = headlessCommand(host, mode, 'say "hi"; --sandbox x', '/work', '/turn/out.txt')
      expect(cmd).not.toBeNull()
      const args = cmd?.args ?? []
      const before = [...args]
      const out = nested(args, mac)
      expect(args).toEqual(before)
      expect(nested(args, mac)).toEqual(out)
      expect(out).not.toEqual(args)
      expect(withoutSandboxFlags(out)).toEqual(withoutSandboxFlags(args))
      // the prompt is never touched, even when it looks like a flag
      expect(out).toContain('say "hi"; --sandbox x')
    })
  }

  const codexSandbox = (mode: AgentMode, platform: NodeJS.Platform) => {
    const out = HOST_PROFILES.codex?.nested?.(headlessCommand('codex', mode, 'p', '/work', '/out')?.args ?? [], { mode, platform }) ?? []
    return out[out.indexOf('--sandbox') + 1]
  }

  test('codex drops its own sandbox only on macOS, where it cannot nest, and only when the mode needs commands', () => {
    for (const mode of ['read', 'edit', 'full'] as const) expect(codexSandbox(mode, 'darwin')).toBe('danger-full-access')
    // Talk needs no command: it stays read-only, so codex itself refuses every write (and macOS every command)
    expect(codexSandbox('talk', 'darwin')).toBe('read-only')
    // elsewhere codex's own sandbox stays as a second layer, at the mode's own setting
    for (const platform of ['linux', 'win32'] as const) {
      expect(codexSandbox('talk', platform)).toBe('read-only')
      expect(codexSandbox('read', platform)).toBe('read-only')
      expect(codexSandbox('edit', platform)).toBe('workspace-write')
      expect(codexSandbox('full', platform)).toBe('workspace-write')
    }
  })

  test('claude and cursor switch their own sandbox off', () => {
    expect(HOST_PROFILES.claude?.nested?.(['-p', 'x'], mac).slice(-2)).toEqual(['--settings', '{"sandbox":{"enabled":false}}'])
    expect(HOST_PROFILES.cursor?.nested?.(['-p', 'x'], mac).slice(-2)).toEqual(['--sandbox', 'disabled'])
  })
})
