/**
 * Names for agents whose owner didn't pick one. They are @mention handles, so they are short, lowercase and easy to
 * type; steppe, council and yurt words plus a few gadget ones. No rank or authority titles (a roster of "khan"s reads
 * oddly next to real admins), and never `all`, which is the reserved `@all` mention.
 */
export const PLAYFUL_NAMES = [
  'yurt', 'felt', 'saddle', 'stirrup', 'falcon', 'hawk', 'eagle', 'tulpar', 'steppe', 'nomad', 'banner', 'drum',
  'kumis', 'ayran', 'kurut', 'boorsok', 'lasso', 'arrow', 'quiver', 'bow', 'camel', 'yak', 'marmot', 'saiga',
  'pony', 'colt', 'mare', 'ember', 'hearth', 'kettle', 'tamga', 'rune', 'ovoo', 'cairn', 'comet', 'pebble',
  'sprout', 'sprocket', 'widget', 'gizmo', 'biscuit', 'noodle', 'pickle', 'zigzag', 'pogo', 'bingo', 'yarrow', 'juniper',
] as const

/**
 * A playful name for `pubkey` that nobody in `taken` has, compared without case or `@machine` suffix, so `FALCON` and
 * `falcon@box` both block `falcon`. The start is read from the pubkey, not drawn at random: an owner's agent key is
 * derived from their seed and the host only, so seating the same CLI on two computers yields one identity, and both
 * machines must pick the same handle or each would keep asking the admins to rename it back to its own. A local
 * collision steps to the next free entry; once every plain name is used, a number is added.
 */
export function pickPlayfulName(pubkey: string, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((n) => n.toLowerCase().replace(/@.*$/, '')))
  const start = (Number.parseInt(pubkey.slice(0, 8), 16) || 0) % PLAYFUL_NAMES.length
  const ordered = PLAYFUL_NAMES.map((_, i) => PLAYFUL_NAMES[(start + i) % PLAYFUL_NAMES.length])
  const free = ordered.find((n) => !used.has(n))
  if (free) return free
  for (let i = 2; ; i++) {
    const candidate = `${ordered[0]}-${i}`
    if (!used.has(candidate)) return candidate
  }
}
