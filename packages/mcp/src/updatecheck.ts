/** A CLI build: its version and the commit it was made from (`dev` from source, `-dirty` with local changes). */
export interface Build {
  version: string
  commit: string
  /** hash of the sources the build was made from: same hash, same code */
  hash?: string
  /** when it was built (ISO time) */
  builtAt?: string
}

/** What CI publishes at the root of the `dist` branch (scripts/build.ts writes it, scripts/assemble-dist.sh copies it). */
export interface BuildInfo extends Build {
  hash: string
  builtAt: string
  /** sha256 of dist/cli.js on the same branch */
  sha256: string
}

export type Verdict =
  /** same commit, or a different commit with the same code (only docs or tests changed) */
  | { kind: 'up-to-date'; sameCode?: boolean }
  /** the published build has a higher version */
  | { kind: 'new-version' }
  /** a different commit under the same version number: a newer build, but the version was not bumped */
  | { kind: 'new-build-same-version' }
  /** this build has a higher version than the published one (a dev build, or the branch moved back) */
  | { kind: 'local-ahead' }

/** Why an update could not go ahead. Thrown for every expected failure, so the caller can say "nothing was changed". */
export class UpdateError extends Error {
  override name = 'UpdateError'
}

const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)

/** Negative when a < b, 0 when equal, positive when a > b. Numeric, so 0.10.0 > 0.9.0. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** Only a real sha identifies a build: `dev`, `unknown` and `-dirty` builds never match a published one. */
export const isSha = (commit: string): boolean => /^[0-9a-f]{7,40}$/.test(commit)

export function compareBuilds(local: Build, remote: Build): Verdict {
  if (isSha(local.commit) && local.commit === remote.commit) return { kind: 'up-to-date' }
  // CI republishes on any push to main, docs included: identical sources are the same build
  if (local.hash && remote.hash && local.hash === remote.hash) return { kind: 'up-to-date', sameCode: true }
  const c = compareVersions(remote.version, local.version)
  if (c > 0) return { kind: 'new-version' }
  if (c < 0) return { kind: 'local-ahead' }
  return { kind: 'new-build-same-version' }
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export function parseBuildInfo(raw: unknown): BuildInfo {
  const m: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {}
  const { version, commit, hash, builtAt, sha256 } = m
  if (!isText(version) || !isText(commit) || !isText(hash) || !isText(builtAt) || !isText(sha256)) throw new UpdateError('build.json is missing fields')
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new UpdateError('build.json has no valid sha256')
  if (!isSha(commit)) throw new UpdateError(`build.json names no commit (${commit})`)
  return { version, commit, hash, builtAt, sha256 }
}
