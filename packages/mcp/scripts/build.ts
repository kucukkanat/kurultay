// Bundle the CLI into <out>/cli.js (default dist/) with a build stamp, and describe it in <out>/build.json:
//   commit   full sha ("-dirty" with uncommitted CLI, core or skill changes). KURULTAY_COMMIT or GITHUB_SHA override it
//   hash     sha256 of the sources the bundle is made of (CLI, core, skill, package.json minus its version). Hashing sources,
//            not the bundle, keeps it the same across machines and Bun versions, so `update` can tell "only docs moved"
//   builtAt  ISO time; KURULTAY_BUILT_AT pins it (tests)
//   sha256   of cli.js, so `kurultay update` can check what it downloaded
// CI copies build.json to the root of the `dist` branch (scripts/assemble-dist.sh).
import { createHash } from 'node:crypto'
import { chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const repo = resolve(root, '../..')
const out = resolve(process.argv[2] ?? join(root, 'dist'))
const SKILL = 'plugins/kurultay/skills/kurultay/SKILL.md'

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

const filesIn = (dir: string): string[] =>
  (readdirSync(join(repo, dir), { recursive: true, encoding: 'utf8' }) as string[]).filter((f) => statSync(join(repo, dir, f)).isFile()).map((f) => join(dir, f))

/** The version is left out: bumping it must not look like a code change. */
function sourceHash(): string {
  const h = createHash('sha256')
  for (const f of [...filesIn('packages/mcp/src'), ...filesIn('packages/core/src'), SKILL].sort()) h.update(f).update('\0').update(readFileSync(join(repo, f))).update('\0')
  const { version: _version, ...pkg }: Record<string, unknown> = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  h.update(JSON.stringify(pkg))
  // the prefix names how the hash is made, so hashes made differently are never compared
  return `src1:${h.digest('hex')}`
}

const sha = commit()
const hash = sourceHash()
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
console.log(`built ${relative(process.cwd(), cli) || cli} ${version} (${sha.replace(/^([0-9a-f]{7})[0-9a-f]+/, '$1')})`)
