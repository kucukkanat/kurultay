import { inMyThread, type GroupState } from '@kurultay/core'

export interface Unread {
  /** messages from others since I last looked */
  count: number
  /** of those, the ones for me */
  mentions: number
}

type Readable = Pick<GroupState, 'history' | 'roster'>

/** The engine's `forMe`, recomputed for stored history so the @ badge and the sound always agree. */
export function isForMe(g: Readable, m: Readable['history'][number], me: string): boolean {
  if (!m.from || m.from === me) return false
  const mentions = m.mentions ?? []
  return g.roster.dm || mentions.includes(me) || mentions.includes('all') || inMyThread(g, m, me)
}

export function unreadSummary(g: Readable, since: number, me: string): Unread {
  const fresh = g.history.filter((m) => m.ts > since && m.from && m.from !== me)
  return { count: fresh.length, mentions: fresh.filter((m) => isForMe(g, m, me)).length }
}
