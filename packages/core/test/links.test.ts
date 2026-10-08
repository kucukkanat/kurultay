import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Kurultay, MemoryStorage, newSecretKey } from '../src'
import { decodeTicket, MAX_COMMAND_LINE, TicketError, wrapCommand } from '../src/links'

const owner = new Kurultay({ sk: newSecretKey(), name: 'tolga', kind: 'human', relays: ['ws://localhost:1'], storage: new MemoryStorage() })
const ticket = owner.createTicket([], { hosts: ['claude', 'codex', 'copilot', 'pi', 'opencode', 'cursor', 'gemini'] })
const command = `printf %s ${ticket}`

describe('wrapCommand', () => {
  test('keeps every line under the limit and leaves short commands alone', () => {
    expect(ticket.length).toBeGreaterThan(1024) // the reason this exists
    const lines = wrapCommand(command).split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MAX_COMMAND_LINE + 1)
    expect(wrapCommand('npx kurultay status')).toBe('npx kurultay status')
  })

  // the point of wrapping: a real shell turns the lines back into the exact same argument, even split mid-word
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(existsSync)) {
    test(`${shell} joins the wrapped lines back into the ticket`, () => {
      const out = spawnSync(shell, ['-c', wrapCommand(command, 97)], { encoding: 'utf8' })
      expect(out.status).toBe(0)
      expect(out.stdout).toBe(ticket)
    })
  }
})

describe('decodeTicket', () => {
  test('reads a ticket that still carries the wrapped line breaks', () => {
    expect(decodeTicket(wrapCommand(command, 50)).seed).toBe(decodeTicket(ticket).seed)
  })

  test('a ticket cut off by the terminal says so instead of reporting broken JSON', () => {
    const cut = ticket.slice(0, 907)
    expect(() => decodeTicket(cut)).toThrow(TicketError)
    expect(() => decodeTicket(cut)).toThrow(/cut off: only 898 characters of it arrived/)
  })

  test('anything that is not a ticket is named as such', () => {
    expect(() => decodeTicket('hello')).toThrow('Not a Kurultay agent ticket')
  })
})
