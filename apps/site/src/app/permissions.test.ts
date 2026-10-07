import { expect, test } from 'bun:test'
import type { AgentMode } from '@kurultay/core'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODE_LABEL, modeAfterToggle, modeCaveat, PERMISSIONS, switchesOf, type Permission } from './permissions'
import { SANDBOX_COPY } from './sandbox'

const MODES: AgentMode[] = ['off', 'talk', 'read', 'edit', 'full']
const IDS: Permission[] = PERMISSIONS.map((p) => p.id)

test('each mode shows as the switches up to its level', () => {
  expect(MODES.map((m) => Object.values(switchesOf(m)).filter(Boolean).length)).toEqual([0, 1, 2, 3, 4])
  expect(switchesOf('edit')).toEqual({ answer: true, read: true, edit: true, run: false })
})

test('turning a switch on brings the ones below it', () => {
  expect(modeAfterToggle('off', 'edit', true)).toBe('edit')
  expect(modeAfterToggle('talk', 'run', true)).toBe('full')
  expect(modeAfterToggle('off', 'answer', true)).toBe('talk')
})

test('flipping a switch to where it already is changes nothing', () => {
  expect(modeAfterToggle('full', 'read', true)).toBe('full')
  expect(modeAfterToggle('edit', 'answer', true)).toBe('edit')
  expect(modeAfterToggle('talk', 'run', false)).toBe('talk')
})

test('turning a switch off takes the ones above it', () => {
  expect(modeAfterToggle('full', 'edit', false)).toBe('read')
  expect(modeAfterToggle('full', 'answer', false)).toBe('off')
  expect(modeAfterToggle('read', 'run', false)).toBe('read')
})

test('on then off is stable for every permission', () => {
  // on then off lands on "everything below this switch", whichever side it started from
  for (const p of IDS) expect(modeAfterToggle(modeAfterToggle('off', p, true), p, false)).toBe(modeAfterToggle('full', p, false))
  for (const p of IDS) expect(switchesOf(modeAfterToggle(modeAfterToggle('full', p, false), p, true))[p]).toBe(true)
})

test('a switch is never on unless every switch below it is (run => edit => read => answer)', () => {
  for (const m of MODES)
    for (const p of IDS)
      for (const on of [true, false]) {
        const s = switchesOf(modeAfterToggle(m, p, on))
        expect(IDS.every((id, i) => !s[id] || IDS.slice(0, i).every((below) => s[below]))).toBe(true)
        expect(s[p]).toBe(on)
      }
})

test('turning on the highest switch a mode has returns that mode', () => {
  for (const m of MODES.slice(1)) expect(modeAfterToggle(m, [...IDS].reverse().find((p) => switchesOf(m)[p]) ?? 'answer', true)).toBe(m)
})

// the picker these replaced called the levels Talk only / Read / Edit / Full; owners only ever see the switches now
const RETIRED = /Talk[ -]only|\bFull\b|(at|in) Talk\b|Talk, Read/

test('each mode is named after the highest switch it has on', () => {
  const labels = PERMISSIONS.map((p) => p.label)
  expect(MODES.slice(2).map((m) => MODE_LABEL[m])).toEqual(labels.slice(1))
  expect(MODE_LABEL.talk).toContain(labels[0] ?? '')
  expect(MODE_LABEL.off).toContain(labels[0] ?? '')
})

test('CLI caveats appear only where the CLI is coarser, in the switches’ names', () => {
  expect(modeCaveat(undefined, 'talk')).toBeUndefined()
  expect(modeCaveat('claude', 'read')).toBeUndefined()
  expect(modeCaveat('cursor', 'full')).toBeUndefined()
  expect(modeCaveat('cursor', 'off')).toBeUndefined()
  expect(modeCaveat('cursor', 'edit')).toContain('Only Run commands differs')
  expect(modeCaveat('gemini', 'talk')).toContain('only Answer when tagged on')
  expect(modeCaveat('codex', 'edit')).toContain('run commands')
  for (const host of ['cursor', 'codex', 'copilot', 'gemini']) for (const m of MODES) expect(modeCaveat(host, m) ?? '').not.toMatch(RETIRED)
  expect(Object.values(MODE_LABEL).join(' ')).not.toMatch(RETIRED)
  expect(Object.values(SANDBOX_COPY).join(' ')).not.toMatch(RETIRED)
})

test('the docs and READMEs name permissions by their switches', () => {
  const root = join(import.meta.dir, '../../../..')
  const files = [...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => join('docs', f)), 'README.md', 'packages/mcp/README.md']
  const stale = files.filter((f) => RETIRED.test(readFileSync(join(root, f), 'utf8')))
  expect(stale).toEqual([])
})
