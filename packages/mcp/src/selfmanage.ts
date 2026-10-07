import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { HOSTS, LABEL, uninstallFor } from './install'
import { configRoot } from './instance'
import { stopDaemonAndWait } from './ipc'
import { deleteKey } from './keystore'
import { startService, stopService } from './service'
import { compareBuilds, parseBuildInfo, UpdateError, type Build } from './updatecheck'
import { BUILT_AT, COMMIT, shortCommit, SOURCE_HASH, VERSION, versionDetail } from './version'

/** CI publishes the `dist` branch (pages.yml): build.json and dist/cli.js, as static files. No server of our own. */
export const DEFAULT_UPDATE_URL = 'https://raw.githubusercontent.com/kucukkanat/kurultay/dist'

const updateBase = () => (process.env.KURULTAY_UPDATE_URL || DEFAULT_UPDATE_URL).replace(/\/+$/, '')

/** The background copy `join` places: agent CLIs and the service run this file, so it is the one to update. */
export const runtimePath = (): string => join(configRoot(), 'bin', 'kurultay.mjs')

/** What `kurultay __build` prints: the stamp of the bundle that runs it. */
export const buildStamp = (): Build => ({ version: VERSION, commit: COMMIT, hash: SOURCE_HASH, builtAt: BUILT_AT })

/** Ask a bundle for its stamp. `update` may run from npx or source, so the installed copy is asked, not this process. */
function stampOf(bundle: string): Build | null {
  const r = spawnSync(process.execPath, [bundle, '__build'], { encoding: 'utf8', timeout: 30_000 })
  try {
    const b: Partial<Build> = JSON.parse(r.stdout)
    return typeof b.version === 'string' && typeof b.commit === 'string' ? { version: b.version, commit: b.commit, hash: b.hash, builtAt: b.builtAt } : null
  } catch {
    // copies from before 0.8.0 have no `__build`: they print an error, which is "unknown" rather than a failure
    return null
  }
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch((err: Error) => {
    throw new UpdateError(`could not reach ${url}: ${err.message}`)
  })
  if (!res.ok) throw new UpdateError(`${url} answered HTTP ${res.status}`)
  return res
}

const fetchJson = async (url: string): Promise<unknown> => {
  const text = await (await fetchOk(url)).text()
  try {
    return JSON.parse(text)
  } catch {
    throw new UpdateError(`${url} is not JSON`)
  }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** A published file, checked against the sha256 build.json gives for it. */
async function download(base: string, path: string, sha: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await (await fetchOk(`${base}/${path}`)).arrayBuffer())
  // raw.githubusercontent.com caches each file for minutes: build.json and the file can come from different dist commits
  if (sha256(bytes) !== sha) throw new UpdateError(`${path} does not match build.json (the dist branch probably just moved: try again in a few minutes)`)
  return bytes
}

const NOT_HERE = 'It updates the background copy only: plugin and npx installs fetch the latest build on their own, and pi updates with `pi update`.'

/**
 *   kurultay update            install the published build when it differs (and restart the service if it was running),
 *                              and the sandbox helper programs beside it when they are missing or differ
 *   kurultay update --check    only report; exit 2 when a newer build exists, so scripts can act on it
 *   kurultay update --force    reinstall even when up to date
 * Any failure leaves the installed files as they were and exits 1.
 */
export async function runUpdate(argv: readonly string[]): Promise<number> {
  const runtime = runtimePath()
  if (!existsSync(runtime)) {
    console.error(`There is no background copy at ${runtime} to update. Run the "Add your agents" command from the app first.\n${NOT_HERE}`)
    return 1
  }
  const binDir = dirname(runtime)
  // every file written beside its target, so the renames below are atomic (same file system); removed again on any failure
  const staged: { from: string; to: string }[] = []
  try {
    const base = updateBase()
    console.log(`Checking the published build at ${base}…`)
    const remote = parseBuildInfo(await fetchJson(`${base}/build.json`))
    const local = stampOf(runtime) ?? { version: 'unknown', commit: 'unknown' }
    console.log(`  installed: kurultay ${versionDetail(local.version, local.commit, local.builtAt)}`)
    console.log(`  published: kurultay ${versionDetail(remote.version, remote.commit, remote.builtAt)}`)
    const verdict = compareBuilds(local, remote)
    const force = argv.includes('--force')
    if (verdict.kind === 'local-ahead' && !force) {
      console.log(`The installed copy (${local.version}) is newer than the published one (${remote.version}): nothing to update.`)
      return 0
    }
    // the sandbox helpers beside the bundle: missing in copies installed before they shipped, stale after srt moves on
    const helpers = Object.entries(remote.vendor).filter(([rel, sha]) => {
      const p = join(binDir, 'vendor', rel)
      return force || !existsSync(p) || sha256(readFileSync(p)) !== sha
    })
    const bundleCurrent = verdict.kind === 'up-to-date' && !force
    if (bundleCurrent && helpers.length === 0) {
      console.log(verdict.sameCode ? "You're up to date: the published build has a newer commit with the same code (only docs or tests changed)." : "You're up to date.")
      return 0
    }
    console.log(
      bundleCurrent
        ? `The bundle is up to date, but the sandbox helper programs are missing or out of date: ${helpers.map(([rel]) => rel).join(', ')}.`
        : verdict.kind === 'new-version'
          ? `A new version is available: ${local.version} → ${remote.version}.`
          : verdict.kind === 'new-build-same-version'
            ? `A newer build is available under the same version number (${remote.version}): the commit moved from ${shortCommit(local.commit)} to ${shortCommit(remote.commit)}, but the version was not bumped.`
            : 'Reinstalling the published build.',
    )
    if (argv.includes('--check')) {
      console.log('Run `kurultay update` to install it.')
      return 2
    }
    for (const [rel, sha] of helpers) {
      const to = join(binDir, 'vendor', rel)
      mkdirSync(dirname(to), { recursive: true })
      staged.push({ from: `${to}.new`, to })
      writeFileSync(`${to}.new`, await download(base, `dist/vendor/${rel}`, sha), { mode: 0o755 })
    }
    if (!bundleCurrent) {
      // keeps the .mjs extension: Node loads any other one as CommonJS, and the ES module bundle would not start
      const next = runtime.replace(/\.mjs$/, '.new.mjs')
      // last in line: the helpers are in place before the bundle that uses them
      staged.push({ from: next, to: runtime })
      writeFileSync(next, await download(base, 'dist/cli.js', remote.sha256), { mode: 0o755 })
      if (stampOf(next)?.commit !== remote.commit) throw new UpdateError('the downloaded build does not start')
    }
    for (const { from, to } of staged) renameSync(from, to)
    if (helpers.length) console.log(`✓ Updated the sandbox helper programs in ${join(binDir, 'vendor')}`)
    if (bundleCurrent) return 0
    console.log(`✓ Updated ${runtime} to kurultay ${versionDetail(remote.version, remote.commit, remote.builtAt)}`)
    // restart only a service that was running: an update never starts one you had stopped. Wait for the old one to exit
    // first, or its shutdown removes the new one's socket and port file
    const stopped = await stopDaemonAndWait()
    if (stopped === 'timeout') console.log('! The background service did not stop in time: restarting it anyway.')
    if (stopped !== 'none') {
      const r = startService(runtime)
      console.log(r.ok ? '✓ Restarted the background service.' : `! Could not restart the background service${r.detail ? `: ${r.detail}` : ''}`)
    }
    console.log(`Agent CLIs pick the new copy up when they next start. ${NOT_HERE}`)
    return 0
  } catch (err) {
    if (!(err instanceof UpdateError)) throw err
    console.error(`Update failed: ${err.message}. Nothing was changed.`)
    return 1
  } finally {
    for (const { from } of staged) rmSync(from, { force: true })
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

/** Remove everything `join` and `install` put on this machine: service, host entries, skills, agent keys and the config folder. */
export async function runUninstall(argv: readonly string[]): Promise<number> {
  const root = configRoot()
  if (!argv.includes('--yes') && !argv.includes('-y')) {
    if (!process.stdin.isTTY) {
      console.error('Refusing to uninstall without a terminal to confirm. Pass --yes to proceed.')
      return 1
    }
    console.log(`This removes the Kurultay background service, the kurultay entries and skill in your agent CLIs, your agents' keys and ${root}.\nAgent keys cannot be recovered.`)
    if (!(await confirm('Uninstall Kurultay?'))) return 1
  }
  // no service running is fine: there is nothing to stop. Waiting keeps its shutdown from racing the folder removal below
  await stopDaemonAndWait()
  console.log(`✓ ${stopService()}`)
  for (const host of HOSTS) {
    if (host === 'vscode') continue // per project: join never writes it
    for (const s of uninstallFor(host)) {
      console.log(`${s.status === 'manual' ? '!' : '✓'} ${LABEL[host]}: ${s.status === 'manual' ? '' : 'removed '}${s.what}${s.path ? ` ${s.path}` : ''}`)
      if (s.status === 'manual' && s.detail) console.log(s.detail.replace(/^/gm, '    '))
    }
  }
  // agent keys live in the OS keychain under their instance name
  const instances = join(root, 'instances')
  if (existsSync(instances)) for (const name of readdirSync(instances)) deleteKey(name, join(instances, name))
  rmSync(root, { recursive: true, force: true })
  console.log(`✓ removed ${root}\nKurultay is uninstalled.`)
  return 0
}
