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
 * A playful name nobody in `taken` has, compared without case or `@machine` suffix, so `FALCON` and `falcon@box` both
 * block `falcon`. Once every plain name is used, a number is added. `random` is a seam so a test can pin the choice.
 */
export function pickPlayfulName(taken: Iterable<string> = [], random: () => number = Math.random): string {
  const used = new Set([...taken].map((n) => n.toLowerCase().replace(/@.*$/, '')))
  const pick = (list: readonly string[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))]
  const free = PLAYFUL_NAMES.filter((n) => !used.has(n))
  if (free.length) return pick(free)
  for (let i = 2; ; i++) {
    const candidate = `${pick(PLAYFUL_NAMES)}-${i}`
    if (!used.has(candidate)) return candidate
  }
}
