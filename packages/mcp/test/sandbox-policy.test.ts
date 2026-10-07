import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_PORT, EMPTY_SANDBOX_GRANTS, type AgentMode, type SandboxGrants } from '@kurultay/core'
import { CREDENTIAL_DIRS, domainProblem, expand, overlaps, policyFor, promptNoteFor, validateGrants, within, type GrantCheck, type HostProfile, type PolicyInput } from '../src/sandbox/policy'

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `kurultay-${name}-`)))
const home = tmp('policy-home')
const configRoot = join(home, '.config', 'kurultay')
mkdirSync(configRoot, { recursive: true })
const ctx = { home, configRoot }
const workdir = join(home, 'work')
const turnDir = tmp('policy-turn')

const profile: HostProfile = {
  readPaths: ['~/.claude.json'],
  writePaths: ['~/.claude', '~/.claude/'],
  domains: ['api.anthropic.com'],
  machLookup: ['com.apple.SecurityServer', 'com.apple.SecurityServer'],
  env: { DISABLE_TELEMETRY: '1' },
}
const grants: SandboxGrants = { allowDomains: ['Docs.Example.com', 'docs.example.com'], readPaths: [join(home, 'notes')], writePaths: ['~/scratch'] }
const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({ mode: 'edit', workdir, turnDir, home, installPaths: ['/opt/claude/bin'], profile, grants: EMPTY_SANDBOX_GRANTS, configRoot, ...over })
const errorsOf = (c: GrantCheck) => (c.ok ? [] : c.errors)
const body = (over: Partial<SandboxGrants> = {}) => ({ ...EMPTY_SANDBOX_GRANTS, ...over })

describe('policyFor', () => {
  const MODES: AgentMode[] = ['off', 'talk', 'read', 'edit', 'full']
  const READS: Record<AgentMode, boolean> = { off: false, talk: false, read: true, edit: true, full: true }
  const WRITES: Record<AgentMode, boolean> = { off: false, talk: false, read: false, edit: true, full: true }

  for (const mode of MODES)
    for (const withGrants of [false, true])
      test(`${mode}, ${withGrants ? 'with' : 'without'} grants`, () => {
        const p = policyFor(input({ mode, grants: withGrants ? grants : EMPTY_SANDBOX_GRANTS }))
        const base = [join(home, '.claude.json'), join(home, '.claude'), '/opt/claude/bin', turnDir]
        const granted = withGrants ? [join(home, 'notes'), join(home, 'scratch')] : []
        expect(p.allowRead).toEqual(READS[mode] ? [...base, workdir, ...granted] : base)
        expect(p.allowWrite).toEqual(WRITES[mode] ? [join(home, '.claude'), turnDir, workdir, ...(withGrants ? [join(home, 'scratch')] : [])] : [join(home, '.claude'), turnDir])
        expect(p.denyRead).toEqual([home, configRoot])
        expect(p.denyWrite).toEqual([configRoot])
        expect(p.allowedDomains).toEqual(withGrants ? ['api.anthropic.com', 'docs.example.com'] : ['api.anthropic.com'])
        expect(p.allowMachLookup).toEqual(['com.apple.SecurityServer'])
        expect(p.env).toEqual({ DISABLE_TELEMETRY: '1' })
      })

  test('optional profile fields default to empty', () => {
    const p = policyFor(input({ profile: { readPaths: [], writePaths: [], domains: [] } }))
    expect(p.allowMachLookup).toEqual([])
    expect(p.env).toEqual({})
  })

  test('the config root is never opened, whatever the working folder or grants say', () => {
    const bypass: SandboxGrants = {
      allowDomains: ['localhost', `localhost:${DAEMON_PORT}`, 'https://evil.example/x'],
      readPaths: ['~/.config', configRoot, '~/.ssh', '/', 'relative/path'],
      writePaths: [join(configRoot, 'bin'), home],
    }
    for (const wd of [join(configRoot, 'instances', 'a'), configRoot, join(home, '.config')]) {
      const p = policyFor(input({ mode: 'full', workdir: wd, grants: bypass }))
      for (const allowed of [...p.allowRead, ...p.allowWrite]) expect(overlaps(allowed, configRoot)).toBe(false)
      expect(p.allowRead).not.toContain(join(home, '.ssh'))
      expect(p.allowRead).not.toContain('/')
      expect(p.allowWrite).not.toContain(home)
      expect(p.allowedDomains).toEqual(['api.anthropic.com'])
      expect(p.denyRead).toContain(configRoot)
      expect(p.denyWrite).toContain(configRoot)
    }
  })

  test('a profile path that is not absolute is a bug and fails loud', () => {
    expect(() => policyFor(input({ profile: { ...profile, readPaths: ['.claude'] } }))).toThrow('not an absolute path')
  })
})

test('expand resolves ~ against home and refuses relative paths', () => {
  expect(expand('~', home)).toBe(home)
  expect(expand('~/a/../b/', home)).toBe(join(home, 'b'))
  expect(expand('/x//y/', home)).toBe('/x/y')
  expect(expand('x', home)).toBeUndefined()
  expect(expand('~other/x', home)).toBeUndefined()
})

test('within and overlaps compare whole path segments', () => {
  expect(within('/a/b', '/a')).toBe(true)
  expect(within('/a', '/a')).toBe(true)
  expect(within('/ab', '/a')).toBe(false)
  expect(within('/a/..b', '/a')).toBe(true)
  expect(within('/', '/a')).toBe(false)
  expect(overlaps('/a', '/a/b')).toBe(true)
})

describe('validateGrants', () => {
  test('normalises a good body: ~ expanded, domains lowercased, everything deduplicated', () => {
    const c = validateGrants(
      body({ allowDomains: [' Docs.Example.COM ', 'docs.example.com', '*.example.org', 'example.com:8443', '10.0.0.5'], readPaths: ['~/notes', join(home, 'notes'), ' ~/x '], writePaths: ['~/scratch/../scratch'] }),
      ctx,
    )
    expect(c).toEqual({ ok: true, grants: { allowDomains: ['docs.example.com', '*.example.org', 'example.com:8443', '10.0.0.5'], readPaths: [join(home, 'notes'), join(home, 'x')], writePaths: [join(home, 'scratch')] } })
  })

  test('the empty grants are valid', () => {
    expect(validateGrants(body(), ctx)).toEqual({ ok: true, grants: EMPTY_SANDBOX_GRANTS })
  })

  const PROTECTED = ['/', home, '~', '~/', join(home, '..'), join(home, '..', '..'), configRoot, join(configRoot, 'bin'), join(configRoot, 'daemon.sock'), '~/.config', ...CREDENTIAL_DIRS.flatMap((d) => [`~/${d}`, `~/${d}/inner/file`])]
  for (const field of ['readPaths', 'writePaths'] as const)
    test(`every protected path is refused as ${field}`, () => {
      for (const p of PROTECTED) {
        const errors = errorsOf(validateGrants(body({ [field]: [p] }), ctx))
        expect(errors).toHaveLength(1)
        expect(errors[0]).toMatchObject({ field, value: p })
      }
    })

  test('reasons name what is protected', () => {
    const reason = (p: string) => errorsOf(validateGrants(body({ readPaths: [p] }), ctx))[0]?.reason
    expect(reason('/')).toContain('whole disk')
    expect(reason(join(home, '..'))).toContain('home folder')
    expect(reason(join(configRoot, 'x'))).toContain("Kurultay's own settings")
    expect(reason('~/.ssh')).toBe('~/.ssh holds credentials and can never be opened')
    expect(reason('notes')).toContain('full path')
  })

  test('a real symlink cannot smuggle ~/.ssh in, even through a folder that does not exist yet', () => {
    mkdirSync(join(home, '.ssh'), { recursive: true })
    symlinkSync(join(home, '.ssh'), join(home, 'innocent'))
    expect(errorsOf(validateGrants(body({ readPaths: ['~/innocent', '~/innocent/not-yet/there'] }), ctx)).map((e) => e.reason)).toEqual([
      '~/.ssh holds credentials and can never be opened',
      '~/.ssh holds credentials and can never be opened',
    ])
  })

  test('a symlinked home is checked by where it really leads', () => {
    const real = tmp('policy-realhome')
    const link = join(tmp('policy-link'), 'home')
    symlinkSync(real, link)
    const linked = { home: link, configRoot: join(link, '.config', 'kurultay') }
    expect(errorsOf(validateGrants(body({ writePaths: [join(real, '.aws'), join(real, '.config', 'kurultay', 'bin')] }), linked))).toHaveLength(2)
  })

  test('a path that cannot be resolved is refused, not thrown', () => {
    const loop = tmp('policy-loop')
    symlinkSync(join(loop, 'b'), join(loop, 'a'))
    symlinkSync(join(loop, 'a'), join(loop, 'b'))
    expect(errorsOf(validateGrants(body({ readPaths: [join(loop, 'a')] }), ctx))[0]?.reason).toContain('cannot be checked')
  })

  test('domains: hosts, wildcards and ports only; nothing on this computer', () => {
    for (const d of ['example.com', '*.example.com', 'example.com:8443', 'a-b.example.co.uk', 'intranet', '192.168.1.10:8080']) expect(domainProblem(d)).toBeUndefined()
    const bad = ['https://example.com', 'example.com/path', 'exa mple.com', '', '*', '*.com', '**.example.com', 'example.*.com', '-example.com', 'example-.com', 'example.com:0', 'example.com:65536', 'example.com:', 'localhost', `localhost:${DAEMON_PORT}`, 'api.localhost:8080', '127.0.0.1:9000', '0.0.0.0', '[::1]', 'user@example.com']
    for (const d of bad) expect(domainProblem(d)).toBeString()
    expect(domainProblem('*.com')).toContain('wildcard')
    expect(domainProblem('example.com:0')).toContain('port')
    expect(domainProblem('localhost')).toContain('this computer')
    expect(errorsOf(validateGrants(body({ allowDomains: ['HTTPS://Example.com'] }), ctx))[0]).toEqual({
      field: 'allowDomains',
      value: 'HTTPS://Example.com',
      reason: 'must be a host name like example.com, *.example.com or example.com:8443, without https:// or a path',
    })
  })

  test('every error is collected, not just the first', () => {
    const errors = errorsOf(validateGrants({ allowDomains: ['a b'], readPaths: ['/', '~/.ssh'], writePaths: 'nope' }, ctx))
    expect(errors.map((e) => e.field)).toEqual(['allowDomains', 'readPaths', 'readPaths', 'writePaths'])
    expect(errors.find((e) => e.field === 'writePaths')).toEqual({ field: 'writePaths', value: '"nope"', reason: 'must be a list of paths' })
  })

  test('a body that is not an object fails on every field', () => {
    for (const raw of [null, undefined, 'grants', 42, []]) {
      const errors = errorsOf(validateGrants(raw, ctx))
      expect(errors.map((e) => e.field)).toEqual(['allowDomains', 'readPaths', 'writePaths'])
      expect(errors[0]?.value).toBe('undefined')
    }
  })
})

describe('promptNoteFor', () => {
  test('working folder and websites', () => {
    expect(promptNoteFor({ workdir: '/w', grants: EMPTY_SANDBOX_GRANTS, domains: ['api.anthropic.com', 'docs.example.com'], mode: 'edit' })).toBe(
      'You run in a sandbox: you can reach your working folder (/w) and these websites: api.anthropic.com, docs.example.com. Anything else is blocked; if something you need is blocked, say so instead of retrying.',
    )
  })

  test('granted folders are listed once, and no websites is said plainly', () => {
    expect(promptNoteFor({ workdir: '/w', grants: { ...EMPTY_SANDBOX_GRANTS, readPaths: ['/a', '/b'], writePaths: ['/b', '/c'] }, domains: [], mode: 'read' })).toBe(
      'You run in a sandbox: you can reach your working folder (/w), and these granted folders: /a, /b, /c, and no websites. Anything else is blocked; if something you need is blocked, say so instead of retrying.',
    )
  })

  test('talk and off promise no folder', () => {
    for (const mode of ['talk', 'off'] as const)
      expect(promptNoteFor({ workdir: '/w', grants: EMPTY_SANDBOX_GRANTS, domains: ['api.anthropic.com'], mode })).toBe(
        'You run in a sandbox: you have no file access and can reach these websites: api.anthropic.com. Anything else is blocked; if something you need is blocked, say so instead of retrying.',
      )
  })
})
