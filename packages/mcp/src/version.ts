import pkg from '../package.json'

declare const __KURULTAY_COMMIT__: string | undefined
declare const __KURULTAY_SOURCE_HASH__: string | undefined
declare const __KURULTAY_BUILT_AT__: string | undefined

/** The one place the version lives is package.json. Bump it whenever the CLI (or the core and skill it bundles) changes. */
export const VERSION: string = pkg.version

/** The commit this bundle was built from (full sha, "-dirty" with uncommitted changes); scripts/build.ts puts it in. "dev" from source. */
export const COMMIT: string = typeof __KURULTAY_COMMIT__ === 'string' ? __KURULTAY_COMMIT__ : 'dev'

/** Hash of the sources the bundle was made from (scripts/build.ts); undefined from source. */
export const SOURCE_HASH: string | undefined = typeof __KURULTAY_SOURCE_HASH__ === 'string' ? __KURULTAY_SOURCE_HASH__ : undefined

/** When the bundle was built (ISO, UTC); undefined from source. */
export const BUILT_AT: string | undefined = typeof __KURULTAY_BUILT_AT__ === 'string' ? __KURULTAY_BUILT_AT__ : undefined

const UNITS: readonly (readonly [string, number])[] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]

/** "3 days ago", "1 hour ago"; under a minute (or a clock running behind) is "just now". */
export function timeAgo(from: Date, now: Date): string {
  const s = (now.getTime() - from.getTime()) / 1000
  const unit = UNITS.find(([, secs]) => s >= secs)
  if (!unit) return 'just now'
  const n = Math.floor(s / unit[1])
  return `${n} ${unit[0]}${n === 1 ? '' : 's'} ago`
}

/** 7 characters of the sha, keeping a "-dirty" marker: `abc1234` or `abc1234-dirty` */
export const shortCommit = (commit = COMMIT): string => commit.replace(/^([0-9a-f]{7})[0-9a-f]+/, '$1')

/** `x.y.z (abc1234)`: the commit makes builds under one version number tell apart */
export const versionLine = (version = VERSION, commit = COMMIT): string => `${version} (${shortCommit(commit)})`

/** `2026-10-05 15:16 (3 days ago)` in local time; empty when the time is unknown or invalid. */
export function builtAtLine(builtAt: string | undefined = BUILT_AT, now: Date = new Date()): string {
  const d = builtAt ? new Date(builtAt) : undefined
  if (!d || Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} (${timeAgo(d, now)})`
}

/** What `kurultay --version` prints: `x.y.z (abc1234) built 2026-10-05 15:16 (3 days ago)` */
export function versionDetail(version = VERSION, commit = COMMIT, builtAt: string | undefined = BUILT_AT, now: Date = new Date()): string {
  const at = builtAtLine(builtAt, now)
  return `${versionLine(version, commit)}${at ? ` built ${at}` : ''}`
}
