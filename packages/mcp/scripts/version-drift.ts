/**
 * Version drift: the CLI's code changed but its version did not. The build hash identifies the code (a hash of the sources the
 * bundle and the dist branch are made from, not of the bundle), so it is the same across commits, machines and Bun versions:
 * a docs-only or test-only commit keeps it, and any other change needs a higher version.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions } from '../src/updatecheck'

export interface Build {
  readonly version: string
  readonly buildHash?: string
}

export interface HashInput {
  readonly path: string
  readonly bytes: Uint8Array
}

/** What the bundle and the dist branch are made of, relative to the repository root. */
export const HASHED = ['packages/mcp/src', 'packages/mcp/pi', 'packages/core/src', 'plugins/kurultay/skills'] as const
/**
 * Files outside those folders that still shape what ships: the lockfile pins the versions the bundle inlines (nostr-tools, the
 * MCP SDK, zod, ws... mostly through ^ ranges), build.ts sets cli.js's `define`/`external` and copies the sandbox's vendor/
 * programs, and assemble-dist.sh writes the dist package.json (bin, pi manifest). The lockfile is the whole workspace's, so a
 * site-only dependency change asks for a CLI bump too: an unneeded bump is cheap, the same version shipping other code is not.
 */
export const HASHED_FILES = ['bun.lock', 'packages/mcp/scripts/build.ts', 'scripts/assemble-dist.sh'] as const
/** In-process relay and Blossom server for tests: never bundled. */
const UNHASHED = 'packages/core/src/testing/'

/**
 * `src3:` + sha256 over every file (sorted by path: path, NUL, bytes, NUL) and then `pkg`. The prefix names how the hash is
 * made, so hashes made differently are never compared (src1 hashed all of package.json and no pi/ folder; src2 missed
 * the lockfile, core's dependencies and the build and assemble scripts).
 */
export function sourceHash(inputs: readonly HashInput[], pkg: unknown): string {
  const h = createHash('sha256')
  for (const f of [...inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(f.path).update('\0').update(f.bytes).update('\0')
  return `src3:${h.update(JSON.stringify(pkg)).digest('hex')}`
}

/**
 * The hashed files of the working tree. `git ls-files` (tracked plus untracked, minus ignored) rather than a directory walk, so
 * ignored litter such as .DS_Store never makes a local hash differ from CI's.
 */
export function hashInputs(repo: string): { files: HashInput[]; pkg: unknown } {
  const r = Bun.spawnSync(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...HASHED, ...HASHED_FILES], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ls-files failed in ${repo}: ${r.stderr.toString().trim()}`)
  const paths = [...new Set(r.stdout.toString().split('\0'))].filter((p) => p && !p.startsWith(UNHASHED) && existsSync(join(repo, p)))
  const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(join(repo, path), 'utf8'))
  const { dependencies, devDependencies, bin, engines } = json('packages/mcp/package.json')
  // Only what goes into the bundle or the dist package.json: version and scripts edits are not code changes. The sandbox's
  // vendored helper programs are covered by the exact @anthropic-ai/sandbox-runtime pin here.
  const pkg = { dependencies, devDependencies, bin, engines, core: { dependencies: json('packages/core/package.json').dependencies } }
  return { files: paths.map((path) => ({ path, bytes: readFileSync(join(repo, path)) })), pkg }
}

export const repoSourceHash = (repo: string): string => {
  const { files, pkg } = hashInputs(repo)
  return sourceHash(files, pkg)
}

/** how a hash was made: the part before the colon */
const scheme = (hash: string) => hash.slice(0, Math.max(0, hash.indexOf(':')))

/** null when fine, otherwise what to tell the developer */
export function driftProblem(published: Build, next: Build): string | null {
  // published before hashes existed, or hashed another way: nothing to compare
  if (!published.buildHash || !next.buildHash || scheme(published.buildHash) !== scheme(next.buildHash)) return null
  if (published.buildHash === next.buildHash) return null
  const c = compareVersions(next.version, published.version)
  if (c === 0)
    return `The CLI changed but its version is still ${next.version}. Bump "version" in packages/mcp/package.json (kurultay --version shows it, kurultay update announces it), then check with: bun run --cwd packages/mcp check:version`
  if (c < 0) return `The CLI changed and its version went backwards: ${published.version} is published, this is ${next.version}. Raise "version" in packages/mcp/package.json.`
  return null
}
