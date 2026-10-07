import type { RelayInfo } from './relay'

export type RelayHealth = 'ok' | 'down'
/** URLs that have closed or errored since they were last open. */
export type FailedRelays = ReadonlySet<string>
type RelaySeen = Pick<RelayInfo, 'url' | 'status'>

/** Fold one relay status event into the failed set. Returns the same set when nothing changed, so callers can compare by reference. */
export function noteRelay(failed: FailedRelays, r: RelaySeen): FailedRelays {
  const failing = r.status === 'closed' || r.status === 'error'
  if (r.status === 'connecting' || failing === failed.has(r.url)) return failed
  const next = new Set(failed)
  if (failing) next.add(r.url)
  else next.delete(r.url)
  return next
}

/**
 * 'down' only when every relay has failed at least once and none is open. Waiting for each relay
 * to fail once avoids a false alarm while the page is still making its first connections.
 */
export function relayHealth(relays: readonly RelaySeen[], failed: FailedRelays): RelayHealth {
  if (relays.length === 0 || relays.some((r) => r.status === 'open')) return 'ok'
  return relays.every((r) => failed.has(r.url)) ? 'down' : 'ok'
}
