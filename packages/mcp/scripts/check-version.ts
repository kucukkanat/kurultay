// Version-bump guard: fail when the CLI's code changed but its version did not.
//   bun scripts/check-version.ts <built-dir> [<published-dir>]
// Each folder is an assembled dist (scripts/assemble-dist.sh): package.json for the version, BUILD_HASH for the code.
// Without <published-dir> the public `dist` branch is cloned (KURULTAY_DIST_REMOTE overrides the remote, for tests).
// Exit codes: 0 fine, 1 drift or the published side could not be fetched, 2 usage.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Build, driftProblem } from './version-drift'

const REMOTE = process.env.KURULTAY_DIST_REMOTE || 'https://github.com/kucukkanat/kurultay.git'

const fail = (message: string, code: 1 | 2): never => {
  console.error(message)
  process.exit(code)
}

function read(dir: string): Build {
  const pkg = join(dir, 'package.json')
  if (!existsSync(pkg)) return fail(`${pkg} is missing: is ${dir} an assembled dist?`, 2)
  const { version }: { version?: unknown } = JSON.parse(readFileSync(pkg, 'utf8'))
  if (typeof version !== 'string') return fail(`${pkg} has no version`, 2)
  const hash = join(dir, 'BUILD_HASH')
  return { version, buildHash: existsSync(hash) ? readFileSync(hash, 'utf8').trim() : undefined }
}

const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })

/** The published dist, or null when there is none yet. Unreachable remotes fail loudly: a network error must not pass as "fine". */
function clonePublished(): string | null {
  const heads = git('ls-remote', '--exit-code', '--heads', REMOTE, 'dist')
  // exit 2: the remote answered and has no `dist` branch. That is the first rollout, with nothing to compare against.
  if (heads.exitCode === 2) return null
  if (heads.exitCode !== 0) return fail(`cannot reach ${REMOTE}: ${heads.stderr.toString().trim()}`, 1)
  const dir = mkdtempSync(join(tmpdir(), 'kurultay-published-'))
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  const clone = git('clone', '-q', '--depth', '1', '-b', 'dist', REMOTE, dir)
  return clone.exitCode === 0 ? dir : fail(`cannot clone the dist branch of ${REMOTE}: ${clone.stderr.toString().trim()}`, 1)
}

const [built, given] = process.argv.slice(2)
if (!built) fail('usage: bun scripts/check-version.ts <built-dir> [<published-dir>]', 2)
else {
  const next = read(built)
  const publishedDir = given ?? clonePublished()
  if (publishedDir === null) console.log(`version ok: ${next.version} (no dist branch published yet)`)
  else {
    const published = read(publishedDir)
    const problem = driftProblem(published, next)
    if (problem) fail(`version drift: ${problem}`, 1)
    console.log(`version ok: ${next.version} (published ${published.version}${published.buildHash ? '' : ', no build hash to compare'})`)
  }
}
