/**
 * How often the page talks to the local daemon. Every failed look is a refused connection the browser logs and nothing
 * can silence, so searching backs off: quick at first (a daemon that is starting is found at once), then every 30 s.
 * Coming back to the tab looks straight away. Once paired the page polls the state; while a code waits, the approval.
 */
export const SEARCH_FIRST_MS = 3000
export const SEARCH_MAX_MS = 30_000
export const STATE_POLL_MS = 2000
export const PAIR_POLL_MS = 1500

/** Delay before the next look after `misses` failed looks in a row (0 after a success). */
export const nextSearchDelay = (misses: number): number => Math.min(SEARCH_MAX_MS, SEARCH_FIRST_MS * 2 ** Math.max(0, misses - 1))

export type DaemonStatus = 'searching' | 'unpaired' | 'pairing' | 'connected'

export const nextDelay = (status: DaemonStatus, misses: number): number =>
  status === 'connected' ? STATE_POLL_MS : status === 'pairing' ? PAIR_POLL_MS : nextSearchDelay(misses)

/** Safari blocks a secure page from reaching http://127.0.0.1, so there the daemon can never be found. */
export const blocksLoopback = (userAgent: string, protocol: string): boolean => protocol === 'https:' && /^((?!chrome|chromium|android|crios|fxios|edg).)*safari/i.test(userAgent)
