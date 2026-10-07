import { useEffect } from 'preact/hooks'
import { PHONE_QUERY } from '../shared/theme'

export type DrawerDir = 'open' | 'close'
/** edge: how close to the left edge a touch must start to open the drawer; distance: minimum travel; slope: max |dy|/|dx|. */
export const DRAWER = { edge: 24, distance: 70, slope: 0.6 } as const

/** A drawer swipe is mostly horizontal and long enough to be on purpose; anything steeper was a scroll. */
export const isDrawerSwipe = (dx: number, dy: number, dir: DrawerDir): boolean =>
  (dir === 'open' ? dx : -dx) >= DRAWER.distance && Math.abs(dy) < Math.abs(dx) * DRAWER.slope

/** Whether a touch starting at x may become a drawer swipe: phones only, from the left edge, or anywhere to close it. */
export const drawerStart = (x: number, open: boolean, narrow: boolean): boolean => narrow && (open || x <= DRAWER.edge)

/** The first touch, typed as possibly missing: TouchList's index signature claims a Touch even when the list is empty. */
const first = (list: TouchList): Touch | undefined => list[0]

/**
 * On phones the council list is a drawer: swipe in from the left edge to open it, swipe left to close it.
 * The listeners are passive and decide only at touchend, so scrolling stays native (nothing calls preventDefault).
 * The iOS back-swipe also starts at the left edge; the app is a single page, so that conflict is accepted.
 */
export function useDrawerSwipe(open: boolean, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    const narrow = matchMedia(PHONE_QUERY)
    let start: { x: number; y: number } | null = null
    const onStart = (ev: TouchEvent) => {
      const t = first(ev.touches)
      start = t && drawerStart(t.clientX, open, narrow.matches) ? { x: t.clientX, y: t.clientY } : null
    }
    const onEnd = (ev: TouchEvent) => {
      const t = first(ev.changedTouches)
      if (start && t && isDrawerSwipe(t.clientX - start.x, t.clientY - start.y, open ? 'close' : 'open')) setOpen(!open)
      start = null
    }
    addEventListener('touchstart', onStart, { passive: true })
    addEventListener('touchend', onEnd, { passive: true })
    return () => {
      removeEventListener('touchstart', onStart)
      removeEventListener('touchend', onEnd)
    }
  }, [open, setOpen])
}
