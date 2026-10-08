import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { driftProblem, hashInputs, sourceHash } from '../scripts/version-drift'

setDefaultTimeout(120_000)

const pkgDir = join(import.meta.dir, '..')
const repo = resolve(pkgDir, '../..')
const tmp = mkdtempSync(join(tmpdir(), 'kurultay-version-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const H1 = `src3:${'1'.repeat(64)}`
const H2 = `src3:${'2'.repeat(64)}`

describe('driftProblem', () => {
  test('same code passes, whatever the version', () => expect(driftProblem({ version: '0.8.0', buildHash: H1 }, { version: '0.8.0', buildHash: H1 })).toBeNull())
  test('changed and bumped passes', () => expect(driftProblem({ version: '0.8.0', buildHash: H1 }, { version: '0.9.0', buildHash: H2 })).toBeNull())
  test('changed with the same version asks for a bump', () => expect(driftProblem({ version: '0.8.0', buildHash: H1 }, { version: '0.8.0', buildHash: H2 })).toContain('Bump'))
  test('a lower version is reported as going backwards', () => expect(driftProblem({ version: '0.9.0', buildHash: H1 }, { version: '0.8.0', buildHash: H2 })).toContain('backwards'))
  test('a published build without a hash cannot be compared', () => expect(driftProblem({ version: '0.8.0' }, { version: '0.8.0', buildHash: H2 })).toBeNull())
  test('hashes made another way cannot be compared', () => expect(driftProblem({ version: '0.8.0', buildHash: 'src1:abc' }, { version: '0.8.0', buildHash: H2 })).toBeNull())
  test('same scheme, different hash asks for a bump', () => expect(driftProblem({ version: '0.8.0', buildHash: 'src3:abc' }, { version: '0.8.0', buildHash: 'src3:abd' })).toContain('Bump'))
})

describe('sourceHash', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)
  const files = [
    { path: 'a.ts', bytes: bytes('one') },
    { path: 'b/c.ts', bytes: bytes('two') },
  ]
  const deps = { dependencies: { x: '1' } }
  const base = sourceHash(files, deps)

  test('names its scheme and is a sha256', () => expect(base).toMatch(/^src3:[0-9a-f]{64}$/))
  test('input order does not matter', () => expect(sourceHash([...files].reverse(), deps)).toBe(base))
  test('a changed byte changes it', () => expect(sourceHash(files.map((f) => (f.path === 'b/c.ts' ? { ...f, bytes: bytes('twp') } : f)), deps)).not.toBe(base))
  test('a renamed file changes it', () => expect(sourceHash(files.map((f) => ({ ...f, path: `x/${f.path}` })), deps)).not.toBe(base))
  test('dependencies change it', () => expect(sourceHash(files, { dependencies: { x: '2' } })).not.toBe(base))

  test('the repository inputs: CLI, pi, core and skill sources, lockfile, build and assemble scripts; no tests, docs or core testing helpers', () => {
    const { files: inputs, pkg } = hashInputs(repo)
    const paths = inputs.map((f) => f.path)
    for (const p of ['packages/mcp/src/cli.ts', 'packages/mcp/pi/extension.ts', 'packages/core/src/engine.ts', 'plugins/kurultay/skills/kurultay/SKILL.md', 'bun.lock', 'packages/mcp/scripts/build.ts', 'scripts/assemble-dist.sh'])
      expect(paths).toContain(p)
    expect(paths.filter((p) => p.includes('/test/') || p.startsWith('packages/core/src/testing/') || p.startsWith('docs/') || p.endsWith('README.md'))).toEqual([])
    // only what goes into the bundle: a version bump or a new script is not a code change
    expect(Object.keys(pkg as object).sort()).toEqual(['bin', 'core', 'dependencies', 'devDependencies', 'engines'])
    expect(pkg).toMatchObject({ core: { dependencies: { 'nostr-tools': expect.any(String), '@noble/hashes': expect.any(String) } } })
  })
})

/** an assembled dist as far as the guard cares: package.json and, when given, BUILD_HASH */
function distDir(name: string, version: string, hash?: string): string {
  const dir = join(tmp, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'kurultay', version }))
  if (hash) writeFileSync(join(dir, 'BUILD_HASH'), `${hash}\n`)
  return dir
}

const check = (args: string[], remote?: string) => {
  const r = Bun.spawnSync(['bun', 'scripts/check-version.ts', ...args], { cwd: pkgDir, env: { ...process.env, KURULTAY_DIST_REMOTE: remote ?? 'file:///nonexistent' }, stdout: 'pipe', stderr: 'pipe' })
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }
}

describe('check-version.ts with both folders', () => {
  const published = distDir('published', '0.8.0', H1)
  test('drift fails with exit 1', () => {
    const r = check([distDir('drift', '0.8.0', H2), published])
    expect(r.code).toBe(1)
    expect(r.out).toContain('Bump')
  })
  test('bumped, identical and hashless published builds pass', () => {
    expect(check([distDir('bumped', '0.9.0', H2), published]).code).toBe(0)
    expect(check([distDir('same', '0.8.0', H1), published]).code).toBe(0)
    expect(check([distDir('next', '0.8.0', H2), distDir('old', '0.7.0')]).code).toBe(0)
  })
  test('usage errors exit 2', () => {
    expect(check([]).code).toBe(2)
    expect(check([join(tmp, 'missing'), published]).code).toBe(2)
  })
})

describe('check-version.ts cloning the dist branch', () => {
  const git = (cwd: string, ...args: string[]) => expect(Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }).exitCode).toBe(0)
  function remote(name: string, branch: string): string {
    const dir = distDir(name, '0.8.0', H1)
    git(dir, 'init', '-q', '-b', branch)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'published')
    return `file://${dir}`
  }
  const next = distDir('cloned-next', '0.8.0', H2)

  test('drift against the published branch fails', () => {
    const r = check([next], remote('with-dist', 'dist'))
    expect(r.code).toBe(1)
    expect(r.out).toContain('Bump')
  })
  test('no dist branch yet passes: the first rollout', () => expect(check([next], remote('without-dist', 'main')).code).toBe(0))
  test('an unreachable remote fails instead of passing', () => expect(check([next], `file://${join(tmp, 'nowhere')}`).code).not.toBe(0))
})

test('real builds: COMMIT follows the commit, BUILD_HASH only the sources', async () => {
  const build = async (name: string, commit: string) => {
    const out = join(tmp, name)
    const p = Bun.spawn(['bun', 'scripts/build.ts', out], { cwd: pkgDir, env: { ...process.env, KURULTAY_COMMIT: commit }, stdout: 'ignore', stderr: 'inherit' })
    expect(await p.exited).toBe(0)
    return { commit: readFileSync(join(out, 'COMMIT'), 'utf8').trim(), hash: readFileSync(join(out, 'BUILD_HASH'), 'utf8').trim() }
  }
  const [a, b] = await Promise.all([build('build-a', 'a'.repeat(40)), build('build-b', 'b'.repeat(40))])
  expect(a.commit).toBe('a'.repeat(40))
  expect(b.commit).toBe('b'.repeat(40))
  expect(a.hash).toMatch(/^src3:[0-9a-f]{64}$/)
  expect(b.hash).toBe(a.hash)
})

// Claude Code refreshes an installed plugin only when its manifest's version changes, so it must follow the CLI's
test('the Claude Code plugin manifest carries the CLI version', () => {
  const version = (path: string): unknown => JSON.parse(readFileSync(join(repo, path), 'utf8')).version
  expect(version('plugins/kurultay/.claude-plugin/plugin.json')).toBe(version('packages/mcp/package.json'))
})
