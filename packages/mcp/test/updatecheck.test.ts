import { expect, test } from 'bun:test'
import { compareBuilds, compareVersions, parseBuildInfo, UpdateError } from '../src/updatecheck'
import { builtAtLine, shortCommit, timeAgo, versionDetail, versionLine } from '../src/version'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

test('versions compare as numbers, not text', () => {
  expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
  expect(compareVersions('0.8.0', '0.8.0')).toBe(0)
  expect(compareVersions('0.7.9', '0.8.0')).toBeLessThan(0)
  expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0)
})

test('the same commit, or the same code under another commit, is up to date', () => {
  expect(compareBuilds({ version: '0.8.0', commit: A }, { version: '0.8.0', commit: A })).toEqual({ kind: 'up-to-date' })
  expect(compareBuilds({ version: '0.8.0', commit: A, hash: 'src1:x' }, { version: '0.8.0', commit: B, hash: 'src1:x' })).toEqual({ kind: 'up-to-date', sameCode: true })
})

test('newer version, newer build under the same version, and a local build ahead', () => {
  expect(compareBuilds({ version: '0.8.0', commit: A }, { version: '0.9.0', commit: B })).toEqual({ kind: 'new-version' })
  expect(compareBuilds({ version: '0.8.0', commit: A, hash: 'src1:x' }, { version: '0.8.0', commit: B, hash: 'src1:y' })).toEqual({ kind: 'new-build-same-version' })
  expect(compareBuilds({ version: '0.9.0', commit: A }, { version: '0.8.0', commit: B })).toEqual({ kind: 'local-ahead' })
})

test('dev, unknown and dirty builds never match a published one', () => {
  for (const commit of ['dev', 'unknown', `${A}-dirty`]) expect(compareBuilds({ version: '0.8.0', commit }, { version: '0.8.0', commit }).kind).toBe('new-build-same-version')
})

test('short commits keep the dirty marker', () => {
  expect(shortCommit(A)).toBe('aaaaaaa')
  expect(shortCommit(`${A}-dirty`)).toBe('aaaaaaa-dirty')
  expect(shortCommit('dev')).toBe('dev')
  expect(versionLine('0.8.0', A)).toBe('0.8.0 (aaaaaaa)')
})

test('timeAgo picks the largest unit and singular forms', () => {
  const now = new Date('2026-10-08T12:00:00Z')
  const ago = (s: number) => timeAgo(new Date(now.getTime() - s * 1000), now)
  expect(ago(10)).toBe('just now')
  expect(ago(-60)).toBe('just now')
  expect(ago(60)).toBe('1 minute ago')
  expect(ago(150)).toBe('2 minutes ago')
  expect(ago(3600)).toBe('1 hour ago')
  expect(ago(3 * 86400)).toBe('3 days ago')
  expect(ago(7 * 86400)).toBe('1 week ago')
  expect(ago(60 * 86400)).toBe('2 months ago')
  expect(ago(400 * 86400)).toBe('1 year ago')
})

test('builtAtLine shows local time and age, and nothing when the time is unknown', () => {
  const at = new Date(2026, 9, 5, 15, 16)
  expect(builtAtLine(at.toISOString(), new Date(2026, 9, 8, 15, 16))).toBe('2026-10-05 15:16 (3 days ago)')
  expect(builtAtLine(undefined)).toBe('')
  expect(builtAtLine('not a date')).toBe('')
  expect(versionDetail('0.8.0', A, undefined)).toBe('0.8.0 (aaaaaaa)')
  expect(versionDetail('0.8.0', A, at.toISOString(), new Date(2026, 9, 5, 16, 16))).toBe('0.8.0 (aaaaaaa) built 2026-10-05 15:16 (1 hour ago)')
})

test('parseBuildInfo checks every field', () => {
  const ok = { version: '0.8.0', commit: A, hash: 'src1:x', builtAt: '2026-10-08T12:00:00Z', sha256: 'f'.repeat(64) }
  expect(parseBuildInfo(ok)).toEqual({ ...ok, vendor: {} })
  expect(() => parseBuildInfo({ ...ok, hash: undefined })).toThrow(UpdateError)
  expect(() => parseBuildInfo(null)).toThrow('missing fields')
  expect(() => parseBuildInfo({ ...ok, sha256: 'abc' })).toThrow('sha256')
  expect(() => parseBuildInfo({ ...ok, commit: 'dev' })).toThrow('no commit')
  // vendor names become paths under bin/vendor/: plain relative paths only, any name, so later builds can add helpers
  const vendor = { 'seccomp/x64/apply-seccomp': 'a'.repeat(64), 'future/helper.bin': 'b'.repeat(64) }
  expect(parseBuildInfo({ ...ok, vendor }).vendor).toEqual(vendor)
  for (const rel of ['../escape', '/etc/passwd', 'a/../../b', 'a\\b', 'a/..', '']) expect(() => parseBuildInfo({ ...ok, vendor: { [rel]: 'a'.repeat(64) } })).toThrow('invalid vendor entry')
  expect(() => parseBuildInfo({ ...ok, vendor: { 'seccomp/x64/apply-seccomp': 'nope' } })).toThrow('invalid vendor entry')
  expect(() => parseBuildInfo({ ...ok, vendor: 'x' })).toThrow('invalid vendor entry')
})
