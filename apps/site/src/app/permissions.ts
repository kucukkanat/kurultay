import type { AgentMode } from '@kurultay/core'

/**
 * An agent's permission is one of five levels (off < talk < read < edit < full), each including the one below. The app
 * shows them as switches, so each switch drags its dependents along: turning "Edit files" on means it can read too,
 * turning "Read files" off means it can no longer edit or run anything. Every result is still one of the five modes, so
 * nothing on the wire or in the daemon changes.
 */
export type Permission = 'answer' | 'read' | 'edit' | 'run'

export const PERMISSIONS: readonly { id: Permission; label: string; hint: string }[] = [
  { id: 'answer', label: 'Answer when tagged', hint: 'Off keeps it in its councils; it only answers from an open session.' },
  { id: 'read', label: 'Read files', hint: 'May read files in its working folder.' },
  { id: 'edit', label: 'Edit files', hint: 'May change and create files in its working folder.' },
  { id: 'run', label: 'Run commands', hint: 'May run shell commands in its working folder.' },
]

const ORDER: readonly Permission[] = ['answer', 'read', 'edit', 'run']
// LEVELS[n + 1] is the mode with exactly the first n + 1 switches on, so LEVELS[0] (nothing on) is off
const LEVELS: readonly AgentMode[] = ['off', 'talk', 'read', 'edit', 'full']

export const switchesOf = (mode: AgentMode): Record<Permission, boolean> => {
  const level = LEVELS.indexOf(mode) - 1
  return { answer: level >= 0, read: level >= 1, edit: level >= 2, run: level >= 3 }
}

/** The mode after flipping one switch: on brings every switch below along, off takes every switch above with it. */
export const modeAfterToggle = (mode: AgentMode, permission: Permission, on: boolean): AgentMode => {
  // already in that position: keep whatever sits above it rather than silently dropping (or granting) those
  if (switchesOf(mode)[permission] === on) return mode
  const i = ORDER.indexOf(permission)
  return LEVELS[on ? i + 1 : i] ?? mode
}
