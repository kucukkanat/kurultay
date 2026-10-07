/**
 * Developer mode is hidden: no switch anywhere. Typing this word anywhere outside a text field turns it on, and
 * typing it again turns it off. A word, not a key chord, so it cannot be hit by accident and works on every OS.
 */
export const DEV_WORD = 'kurultaydev'

export type Step = Readonly<{ buffer: string; matched: boolean }>

/** Feed one key into the typed-letters buffer; `matched` is true when the key completes the word. */
export function advance(buffer: string, key: string, word = DEV_WORD): Step {
  // Shift, Enter, arrows and the like are named keys, not letters: they neither count nor break the word
  if (key.length !== 1) return { buffer, matched: false }
  const next = (buffer + key.toLowerCase()).slice(-word.length)
  return next === word ? { buffer: '', matched: true } : { buffer: next, matched: false }
}

/** Is the person typing into something (a field, a contentEditable, a field inside a shadow root)? */
export function isTyping(target: EventTarget | null | undefined): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

/** Call `onWord` each time the word is typed outside a text field. Returns the cleanup. */
export function watchWord(onWord: () => void, word = DEV_WORD): () => void {
  let buffer = ''
  const onKey = (e: KeyboardEvent) => {
    // composedPath()[0] is the real target even inside a shadow root, where e.target is only the host
    if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.composedPath()[0])) return
    const r = advance(buffer, e.key, word)
    buffer = r.buffer
    if (r.matched) onWord()
  }
  addEventListener('keydown', onKey)
  return () => removeEventListener('keydown', onKey)
}
