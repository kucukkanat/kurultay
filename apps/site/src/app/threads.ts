import { rootOf, type Message } from '@kurultay/core'

export interface Threads {
  /** what the main chat shows: everything except replies */
  readonly feed: readonly Message[]
  /** replies by thread root id, oldest first */
  readonly replies: ReadonlyMap<string, readonly Message[]>
}

/**
 * Split a council's history into the main chat and its threads. Threads are flat (see `rootOf`), and only chat messages can
 * be replies: system lines, tasks and task updates always stay in the main chat.
 */
export function splitThreads(history: readonly Message[]): Threads {
  const byId = new Map(history.map((m) => [m.id, m]))
  const feed: Message[] = []
  const replies = new Map<string, Message[]>()
  for (const m of history) {
    const root = m.type === 'chat' ? rootOf(byId, m) : m
    if (root === m) feed.push(m)
    else replies.set(root.id, [...(replies.get(root.id) ?? []), m])
  }
  return { feed, replies }
}

/**
 * The message a reply typed in the thread box answers: the newest one from someone else, falling back to the root. An agent
 * that spoke in the thread is then the parent's author, so it is always woken (see `inMyThread` in the engine).
 */
export function replyTarget(root: Message, replies: readonly Message[], me: string): Message {
  return [...replies].reverse().find((m) => m.from !== me) ?? root
}
