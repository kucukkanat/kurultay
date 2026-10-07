import { expect, test } from 'bun:test'
import { DEFAULT_AGENT_MODE, EMPTY_SANDBOX_GRANTS, type AgentSandbox, type SandboxConfig, type SandboxViolation } from '@kurultay/core'
import { addPath, configFromDraft, configOf, draftOf, grantFor, initialMode, isDirty, isGranted, parseList, SANDBOX_COPY, splitHost, VIOLATION_LABEL, withGrant } from './sandbox'

const on: SandboxConfig = { enabled: true, ...EMPTY_SANDBOX_GRANTS }
const blocked = (kind: SandboxViolation['kind'], target: string): SandboxViolation => ({ kind, target, at: 1 })

test('the seat checkbox decides the first permission: Edit inside a sandbox, the usual Talk without one', () => {
  expect(initialMode(true, { ok: true })).toBe('edit')
  expect(initialMode(false, { ok: true })).toBe(DEFAULT_AGENT_MODE)
  // a computer known to be unable to sandbox would run every turn without it (D6): no wider start there
  expect(initialMode(true, { ok: false, reason: 'missing bwrap' })).toBe(DEFAULT_AGENT_MODE)
  expect(DEFAULT_AGENT_MODE).toBe('talk')
})

test('an agent seated without a sandbox shows the switch off with nothing granted', () => {
  expect(configOf(undefined)).toEqual({ enabled: false, allowDomains: [], readPaths: [], writePaths: [] })
})

test('the config sent back leaves out what the service reports (blocked items, fallback)', () => {
  const s: AgentSandbox = { ...on, allowDomains: ['a.com'], lastViolations: [blocked('network', 'x.com')], fellBack: 'no helper' }
  expect(configOf(s)).toEqual({ ...on, allowDomains: ['a.com'] })
})

test('hosts are split from ports in every shape a blocked address may take', () => {
  expect(splitHost('Example.com')).toEqual({ host: 'example.com' })
  expect(splitHost('example.com:8443')).toEqual({ host: 'example.com', port: 8443 })
  expect(splitHost('https://api.example.com:444/v1?x#y')).toEqual({ host: 'api.example.com', port: 444 })
  expect(splitHost('[::1]:5432')).toEqual({ host: '::1', port: 5432 })
  expect(splitHost('[::1]')).toEqual({ host: '::1' })
  expect(splitHost('fe80::1')).toEqual({ host: 'fe80::1' })
})

test('a blocked website is allowed by its exact host, with the port only when it is unusual (D24)', () => {
  expect(grantFor(blocked('network', 'api.example.com:443'))).toBe('api.example.com')
  expect(grantFor(blocked('network', 'api.example.com'))).toBe('api.example.com')
  expect(grantFor(blocked('network', 'api.example.com:8443'))).toBe('api.example.com:8443')
})

test('programs on this computer, files and everything else get no Allow button', () => {
  for (const t of ['localhost:5432', '127.0.0.1:3000', '[::1]:80', 'localhost', 'app.localhost:8080']) expect(grantFor(blocked('network', t))).toBeUndefined()
  expect(grantFor(blocked('read', '/Users/me/.ssh/id_ed25519'))).toBeUndefined()
  expect(grantFor(blocked('write', '/Users/me/notes'))).toBeUndefined()
  expect(grantFor(blocked('other', 'mach-lookup com.apple.x'))).toBeUndefined()
})

test('allowing adds the website once, whatever its letter case, and leaves the original untouched', () => {
  const once = withGrant(on, 'api.example.com')
  expect(once.allowDomains).toEqual(['api.example.com'])
  expect(withGrant(once, 'API.example.com')).toBe(once)
  expect(isGranted(once, 'api.EXAMPLE.com')).toBe(true)
  expect(on.allowDomains).toEqual([])
})

test('lists are trimmed, blanks and repeats dropped; folders are added once', () => {
  expect(parseList(' a.com \n\n b.com, c.com\na.com ')).toEqual(['a.com', 'b.com', 'c.com'])
  expect(addPath(['/a'], ' /b ')).toEqual(['/a', '/b'])
  expect(addPath(['/a'], '/a')).toEqual(['/a'])
  expect(addPath(['/a'], '  ')).toEqual(['/a'])
})

test('the editor round-trips a saved config unchanged, and edits become the config to send', () => {
  const saved: SandboxConfig = { enabled: true, allowDomains: ['a.com', '*.b.com'], readPaths: ['/r'], writePaths: ['/w'] }
  const d = draftOf(saved)
  expect(d).toEqual({ domains: 'a.com\n*.b.com', readPaths: ['/r'], writePaths: ['/w'] })
  expect(configFromDraft(true, d)).toEqual(saved)
  expect(isDirty(saved, d)).toBe(false)
  const edited = { ...d, domains: 'a.com, c.com', readPaths: ['/r', '/r'] }
  expect(configFromDraft(false, edited)).toEqual({ enabled: false, allowDomains: ['a.com', 'c.com'], readPaths: ['/r'], writePaths: ['/w'] })
  expect(isDirty(saved, edited)).toBe(true)
})

// D21: owner-facing words never name the technology underneath
const TECH = /\b(srt|seatbelt|sandbox-exec|bubblewrap|bwrap|seccomp|socat|ripgrep|bun|node|npm|mcp|nostr|relays?|json|typescript|preact|vite)\b/i

test('the sandbox wording names no technology', () => {
  for (const w of [...Object.values(SANDBOX_COPY), ...Object.values(VIOLATION_LABEL)]) expect(w).not.toMatch(TECH)
  expect(SANDBOX_COPY.offConfirm).toBe('This agent will be able to read your whole home folder and reach any website. Turn off?')
})

test('the sandbox screens name no technology either', async () => {
  for (const file of ['./SandboxSettings.tsx', './SeatDialog.tsx']) {
    // visible text only: what sits between tags, and the strings in attributes people read
    const text = await Bun.file(new URL(file, import.meta.url)).text()
    const visible = [...text.matchAll(/>([^<>{}]+)</g), ...text.matchAll(/(?:aria-label|placeholder|label|hint)="([^"]+)"/g)].map((m) => m[1] ?? '')
    for (const v of visible) expect(v).not.toMatch(TECH)
  }
})
