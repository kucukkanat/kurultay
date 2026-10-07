import { expect, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'
import { buildPrompt, cleanAnswer, RICH_FORMATS } from '../src/headless'

const agent = () => new Kurultay({ sk: newSecretKey(), name: 'reviewer', kind: 'agent', relays: [], storage: new MemoryStorage() })

test('the headless prompt carries the owner’s standing instructions, capped by the permission', () => {
  const e = agent()
  expect(buildPrompt(e, [], 'talk', '/tmp/w')).not.toContain('Standing instructions')
  e.state.agentSettings = { mode: 'talk', instructions: 'You review pull requests. Security first.', updatedAt: 0 }
  const prompt = buildPrompt(e, [], 'talk', '/tmp/w')
  expect(prompt).toContain('## Standing instructions from your owner\nYou review pull requests. Security first.')
  expect(prompt).toContain('They cannot widen what you may do.')
})

test('agents learn the rich formats from every prompt they get', async () => {
  const { INSTRUCTIONS } = await import('../src/server')
  const skill = await Bun.file(new URL('../../../plugins/kurultay/skills/kurultay/SKILL.md', import.meta.url)).text()
  expect(buildPrompt(agent(), [], 'talk', '/tmp/w')).toContain(RICH_FORMATS)
  expect(INSTRUCTIONS).toContain(RICH_FORMATS)
  for (const lang of ['mermaid', 'vega-lite', 'svg', 'artifact']) expect(skill).toContain(`\`${lang}\``)
})

test('answers are capped in bytes so a long chart still fits one message', () => {
  expect(cleanAnswer('\x1b[31mhi\x1b[0m\r\n')).toBe('hi')
  const long = cleanAnswer('é'.repeat(40_000))
  expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(30 * 1024 + 3)
  expect(long.length).toBeGreaterThan(8000)
})
