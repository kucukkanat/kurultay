import type { GroupState } from '@kurultay/core'

/** The councils whose key I may rotate: ones I administer, never DMs (they have no shared council key to roll), by name. `filter` copies, so the in-place sort never touches the caller's array. */
export const adminCouncils = (groups: readonly GroupState[], isAdmin: (id: string) => boolean): readonly GroupState[] =>
  groups.filter((g) => !g.roster.dm && isAdmin(g.id)).sort((a, b) => a.roster.name.localeCompare(b.roster.name))

/** Coarse "key changed … ago" label; minute precision is all an admin needs to judge whether a rotation is recent. */
export function keyAge(rotatedAt: number | undefined, nowSec: number): string {
  if (rotatedAt === undefined) return 'key never changed'
  const s = Math.max(0, nowSec - rotatedAt)
  if (s < 60) return 'key changed just now'
  if (s < 3600) return `key changed ${Math.floor(s / 60)} min ago`
  if (s < 86400) return `key changed ${Math.floor(s / 3600)} h ago`
  return `key changed ${Math.floor(s / 86400)} d ago`
}
