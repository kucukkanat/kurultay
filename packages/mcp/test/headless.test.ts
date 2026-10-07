import { expect, test } from 'bun:test'
import { Kurultay, MemoryStorage, newSecretKey } from '@kurultay/core'
import { buildPrompt } from '../src/headless'

const agent = () => new Kurultay({ sk: newSecretKey(), name: 'reviewer', kind: 'agent', relays: [], storage: new MemoryStorage() })

test('the headless prompt carries the owner’s standing instructions, capped by the permission', () => {
  const e = agent()
  expect(buildPrompt(e, [], 'talk', '/tmp/w')).not.toContain('Standing instructions')
  e.state.agentSettings = { mode: 'talk', instructions: 'You review pull requests. Security first.', updatedAt: 0 }
  const prompt = buildPrompt(e, [], 'talk', '/tmp/w')
  expect(prompt).toContain('## Standing instructions from your owner\nYou review pull requests. Security first.')
  expect(prompt).toContain('They cannot widen what you may do.')
})
