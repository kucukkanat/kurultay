import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopDaemonAndWait } from '../src/ipc'

setDefaultTimeout(60_000)

const pkg = join(import.meta.dir, '..')
// short: the daemon's socket lives below it, and macOS caps Unix socket paths at 104 bytes
const tmp = mkdtempSync(join(tmpdir(), 'ksm-'))
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const BUILT = '2026-10-01T12:00:00.000Z'
// read, not written in: every CLI change bumps the version, and these tests must not need editing for it
const VERSION: string = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
const V = VERSION.replaceAll('.', '\\.')

interface Stamp {
  version: string
  commit: string
  hash: string
  builtAt: string
  sha256: string
  vendor: Record<string, string>
}

/** Build the real bundle, stamped as `commit` (what CI does with GITHUB_SHA). */
async function build(name: string, commit: string): Promise<{ cli: string; vendor: string; info: Stamp }> {
  const out = join(tmp, name)
  const p = Bun.spawn(['bun', 'scripts/build.ts', out], { cwd: pkg, env: { ...process.env, KURULTAY_COMMIT: commit, KURULTAY_BUILT_AT: BUILT }, stdout: 'ignore', stderr: 'inherit' })
  expect(await p.exited).toBe(0)
  return { cli: join(out, 'cli.js'), vendor: join(out, 'vendor'), info: JSON.parse(readFileSync(join(out, 'build.json'), 'utf8')) }
}

let a: { cli: string; vendor: string; info: Stamp }
let b: { cli: string; vendor: string; info: Stamp }
/** What the fake `dist` branch serves: build.json, dist/cli.js and dist/vendor/, as raw.githubusercontent.com would */
let published: { info: unknown; cli: string; vendor: string; status: number }
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname
    if (published.status !== 200) return new Response('nope', { status: published.status })
    if (path === '/build.json') return Response.json(published.info)
    if (path === '/dist/cli.js') return new Response(published.cli)
    const helper = join(published.vendor, path.replace(/^\/dist\/vendor\//, ''))
    if (path.startsWith('/dist/vendor/') && existsSync(helper)) return new Response(Bun.file(helper))
    return new Response('not found', { status: 404 })
  },
})

const home = join(tmp, 'home')
const root = join(home, '.config/kurultay')
const runtime = join(root, 'bin/kurultay.mjs')
const vendor = join(root, 'bin/vendor')
const SECCOMP = 'seccomp/x64/apply-seccomp'

async function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(['node', a.cli, ...args], {
    env: { ...process.env, HOME: home, KURULTAY_HOME: root, KURULTAY_NO_SERVICE: '1', KURULTAY_NO_KEYCHAIN: '1', KURULTAY_UPDATE_URL: `http://127.0.0.1:${server.port}`, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out: out + err }
}

beforeAll(async () => {
  ;[a, b] = await Promise.all([build('a', A), build('b', B)])
})
afterAll(() => server.stop(true))
beforeEach(() => {
  mkdirSync(join(root, 'bin'), { recursive: true })
  copyFileSync(a.cli, runtime)
  // what `join` installs: the bundle with its helper programs beside it
  rmSync(vendor, { recursive: true, force: true })
  cpSync(a.vendor, vendor, { recursive: true })
  published = { info: b.info, cli: readFileSync(b.cli, 'utf8'), vendor: b.vendor, status: 200 }
})

test('--version shows the version, short commit and build time; a source run shows dev', async () => {
  const { out } = await run(['--version'])
  expect(out).toMatch(new RegExp(`^${V} \\(aaaaaaa\\) built 2026-10-0\\d \\d\\d:\\d\\d \\(\\d+ \\w+ ago\\)\\n$`))
  const src = Bun.spawnSync(['bun', 'src/cli.ts', 'version'], { cwd: pkg })
  expect(src.stdout.toString().trim()).toBe(`${VERSION} (dev)`)
})

test('update --check: up to date, same code, new version, new build without a bump', async () => {
  published.info = a.info
  expect(await run(['update', '--check'])).toMatchObject({ code: 0, out: expect.stringContaining("You're up to date.") })
  published.info = b.info // same sources under another commit
  expect(await run(['update', '--check'])).toMatchObject({ code: 0, out: expect.stringContaining('same code') })
  published.info = { ...b.info, version: '9.0.0', hash: 'src1:other' }
  expect(await run(['update', '--check'])).toMatchObject({ code: 2, out: expect.stringContaining(`${VERSION} → 9.0.0`) })
  published.info = { ...b.info, hash: 'src1:other' }
  expect(await run(['update', '--check'])).toMatchObject({ code: 2, out: expect.stringContaining('not bumped') })
  expect(readFileSync(runtime)).toEqual(readFileSync(a.cli))
})

test('update replaces the background copy, and --force reinstalls', async () => {
  published.info = { ...b.info, hash: 'src1:other' }
  const up = await run(['update'])
  expect(up.code).toBe(0)
  expect(up.out).toContain('✓ Updated')
  expect(readFileSync(runtime)).toEqual(readFileSync(b.cli))
  expect(existsSync(join(root, 'bin/kurultay.new.mjs'))).toBe(false)
  expect(await run(['update'])).toMatchObject({ code: 0, out: expect.stringContaining("You're up to date.") })
  const forced = await run(['update', '--force'])
  expect(forced).toMatchObject({ code: 0, out: expect.stringContaining('Reinstalling') })
  expect(readFileSync(runtime)).toEqual(readFileSync(b.cli))
})

test('a tampered download, a 404 and an unreachable server change nothing', async () => {
  const before = readFileSync(runtime)
  published.info = { ...b.info, hash: 'src1:other' }
  published.cli = readFileSync(b.cli, 'utf8') + '\n// tampered'
  expect(await run(['update'])).toMatchObject({ code: 1, out: expect.stringContaining('does not match build.json') })
  published.status = 404
  expect(await run(['update'])).toMatchObject({ code: 1, out: expect.stringContaining('HTTP 404') })
  expect(await run(['update'], { KURULTAY_UPDATE_URL: 'http://127.0.0.1:1' })).toMatchObject({ code: 1, out: expect.stringContaining('could not reach') })
  expect(readFileSync(runtime)).toEqual(before)
  expect(existsSync(join(root, 'bin/kurultay.new.mjs'))).toBe(false)
})

test('build.json lists the sha256 of every helper program shipped in vendor/', () => {
  expect(Object.keys(b.info.vendor).sort()).toEqual(['seccomp/arm64/apply-seccomp', SECCOMP, 'srt-win/arm64/srt-win.exe', 'srt-win/x64/srt-win.exe'])
  for (const [rel, sha] of Object.entries(b.info.vendor)) expect(new Bun.CryptoHasher('sha256').update(readFileSync(join(b.vendor, rel))).digest('hex')).toBe(sha)
})

test('update fetches missing or changed helper programs, even when the bundle is up to date', async () => {
  // a copy installed before vendor/ shipped, and one whose helper differs from the published one
  rmSync(join(vendor, 'srt-win'), { recursive: true })
  writeFileSync(join(vendor, SECCOMP), 'old helper')
  published.info = a.info
  const check = await run(['update', '--check'])
  expect(check.code).toBe(2)
  expect(check.out).toContain('helper programs are missing or out of date')
  expect(check.out).toContain(SECCOMP)
  expect(check.out).not.toContain('seccomp/arm64')
  expect(readFileSync(join(vendor, SECCOMP), 'utf8')).toBe('old helper')

  const up = await run(['update'])
  expect(up.code).toBe(0)
  expect(up.out).toContain('✓ Updated the sandbox helper programs')
  expect(up.out).not.toContain(`✓ Updated ${runtime}`)
  for (const rel of Object.keys(b.info.vendor)) expect(readFileSync(join(vendor, rel))).toEqual(readFileSync(join(b.vendor, rel)))
  expect(await run(['update'])).toMatchObject({ code: 0, out: expect.stringContaining("You're up to date.") })
})

test('a helper that does not match build.json changes nothing, the bundle included', async () => {
  rmSync(join(vendor, SECCOMP))
  published.info = { ...b.info, hash: 'src1:other', vendor: { ...b.info.vendor, [SECCOMP]: 'c'.repeat(64) } }
  expect(await run(['update'])).toMatchObject({ code: 1, out: expect.stringContaining(`dist/vendor/${SECCOMP} does not match build.json`) })
  expect(readFileSync(runtime)).toEqual(readFileSync(a.cli))
  expect(existsSync(join(vendor, SECCOMP))).toBe(false)
  expect(existsSync(join(vendor, `${SECCOMP}.new`))).toBe(false)
})

describe('with a running plain-process service', () => {
  // a fixed control port: a new daemon can only take it once the old one has let go of it
  const free = Bun.serve({ port: 0, fetch: () => new Response() })
  const env = { KURULTAY_PORT: String(free.port) }
  free.stop(true)
  const pidOf = async () => (await run(['status'], env)).out.match(/background service \(pid (\d+)\)/)?.[1]
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  let old: ReturnType<typeof Bun.spawn>
  beforeEach(async () => {
    old = Bun.spawn(['node', runtime, 'daemon'], { env: { ...process.env, HOME: home, KURULTAY_HOME: root, KURULTAY_NO_SERVICE: '1', KURULTAY_NO_KEYCHAIN: '1', ...env }, stdout: 'ignore', stderr: 'ignore' })
    for (let i = 0; i < 100 && !(await pidOf()); i++) await Bun.sleep(100)
    expect(await pidOf()).toBe(String(old.pid))
  })
  afterEach(async () => {
    await run(['stop'], env)
    old.kill()
  })

  test('stopDaemonAndWait returns only once the daemon process is gone', async () => {
    const saved = process.env.KURULTAY_HOME
    process.env.KURULTAY_HOME = root
    try {
      expect(await stopDaemonAndWait()).toBe('stopped')
      expect(alive(old.pid)).toBe(false)
      expect(existsSync(join(root, 'daemon.port'))).toBe(false)
      expect(await stopDaemonAndWait()).toBe('none')
    } finally {
      process.env.KURULTAY_HOME = saved
    }
  })

  test('update restarts it, and the new one stays reachable once the old one has exited', async () => {
    published.info = { ...b.info, hash: 'src1:other' }
    const up = await run(['update'], env)
    expect(up.code).toBe(0)
    expect(up.out).toContain('✓ Restarted the background service.')
    expect(alive(old.pid)).toBe(false)
    let fresh: string | undefined
    for (let i = 0; i < 100 && !(fresh = await pidOf()); i++) await Bun.sleep(100)
    // time for a late shutdown of the old daemon to take the socket and port file with it, if it were still running
    await Bun.sleep(1000)
    expect(fresh).not.toBe(String(old.pid))
    expect(await pidOf()).toBe(fresh)
    expect(readFileSync(join(root, 'daemon.port'), 'utf8')).toBe(env.KURULTAY_PORT)
  })
})

test('update without a background copy says how to get one', async () => {
  const r = await run(['update'], { KURULTAY_HOME: join(tmp, 'empty') })
  expect(r).toMatchObject({ code: 1, out: expect.stringContaining('"Add your agents"') })
})

test('uninstall asks first, and with --yes removes host entries, skills, keys and the config folder', async () => {
  expect((await run(['install', 'codex', 'opencode'])).code).toBe(0)
  mkdirSync(join(root, 'instances/codex#1'), { recursive: true })
  writeFileSync(join(root, 'instances/codex#1/secret.key'), 'f'.repeat(64))
  const toml = join(home, '.codex/config.toml')
  writeFileSync(toml, `model = "x"\n\n${readFileSync(toml, 'utf8')}`)

  expect(await run(['uninstall'])).toMatchObject({ code: 1, out: expect.stringContaining('--yes') })
  expect(existsSync(root)).toBe(true)

  const r = await run(['uninstall', '--yes'])
  expect(r).toMatchObject({ code: 0, out: expect.stringContaining('Kurultay is uninstalled.') })
  expect(readFileSync(toml, 'utf8')).toBe('model = "x"\n')
  expect(JSON.parse(readFileSync(join(home, '.config/opencode/opencode.json'), 'utf8')).mcp).toEqual({})
  expect(existsSync(join(home, '.codex/skills/kurultay'))).toBe(false)
  expect(existsSync(join(home, '.config/opencode/skills/kurultay'))).toBe(false)
  expect(existsSync(root)).toBe(false)
})
