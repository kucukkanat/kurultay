// Bundle the CLI into <out>/cli.js (default dist/) with a build stamp, and describe it in <out>/build.json:
//   commit   full sha ("-dirty" with uncommitted CLI, core or skill changes). KURULTAY_COMMIT or GITHUB_SHA override it
//   hash     sha256 of the sources the bundle is made of (scripts/version-drift.ts). Hashing sources, not the bundle, keeps it
//            the same across machines and Bun versions, so `update` can tell "only docs moved" and CI can tell "bump the version"
//   builtAt  ISO time; KURULTAY_BUILT_AT pins it (tests)
//   sha256   of cli.js, so `kurultay update` can check what it downloaded
// It also writes <out>/COMMIT and <out>/BUILD_HASH (one line each) for scripts/check-version.ts, the version-bump guard.
// CI copies build.json, COMMIT and BUILD_HASH to the root of the `dist` branch (scripts/assemble-dist.sh).
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { repoSourceHash } from './version-drift'

const root = resolve(import.meta.dir, '..')
const repo = resolve(root, '../..')
const out = resolve(process.argv[2] ?? join(root, 'dist'))

const git = (...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' })
  return r.exitCode === 0 ? r.stdout.toString().trim() : null
}

function commit(): string {
  const pinned = process.env.KURULTAY_COMMIT || process.env.GITHUB_SHA
  if (pinned) return pinned
  const sha = git('rev-parse', 'HEAD')
  if (!sha) return 'unknown'
  return git('status', '--porcelain', '--', 'packages/mcp', 'packages/core', 'plugins/kurultay/skills') ? `${sha}-dirty` : sha
}

const sha = commit()
const hash = repoSourceHash(repo)
const builtAt = process.env.KURULTAY_BUILT_AT ?? new Date().toISOString()
const built = await Bun.build({
  entrypoints: [join(root, 'src/cli.ts')],
  outdir: out,
  naming: 'cli.js',
  target: 'node',
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    __KURULTAY_COMMIT__: JSON.stringify(sha),
    __KURULTAY_SOURCE_HASH__: JSON.stringify(hash),
    __KURULTAY_BUILT_AT__: JSON.stringify(builtAt),
  },
})
if (!built.success) {
  for (const m of built.logs) console.error(m)
  process.exit(1)
}
const cli = join(out, 'cli.js')
chmodSync(cli, 0o755)
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sha256 = createHash('sha256').update(readFileSync(cli)).digest('hex')
writeFileSync(join(out, 'build.json'), JSON.stringify({ version, commit: sha, hash, builtAt, sha256 }, null, 2) + '\n')
writeFileSync(join(out, 'COMMIT'), `${sha}\n`)
writeFileSync(join(out, 'BUILD_HASH'), `${hash}\n`)
console.log(`built ${relative(process.cwd(), cli) || cli} ${version} (${sha.replace(/^([0-9a-f]{7})[0-9a-f]+/, '$1')})`)
