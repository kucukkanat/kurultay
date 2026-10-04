export type ThemePref = 'auto' | 'light' | 'dark'
const KEY = 'kurultay:theme'

function getTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {}
  return 'auto'
}

function applyTheme(pref: ThemePref = getTheme()) {
  const el = document.documentElement
  if (pref === 'auto') el.removeAttribute('data-theme')
  else el.setAttribute('data-theme', pref)
}

export function isDark() {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr) return attr === 'dark'
  return matchMedia('(prefers-color-scheme: dark)').matches
}

/** Flip between light and dark (remembering the explicit choice). */
export function toggleTheme(): ThemePref {
  const next: ThemePref = isDark() ? 'light' : 'dark'
  try {
    localStorage.setItem(KEY, next)
  } catch {}
  applyTheme(next)
  return next
}

const SUN = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>`
const MOON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>`

/** Wire every [data-theme-toggle] button on the page. */
export function wireThemeToggles() {
  const paint = () => {
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
      b.innerHTML = isDark() ? SUN : MOON
      b.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode')
    }
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    b.addEventListener('click', () => {
      toggleTheme()
      paint()
    })
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint)
  paint()
}
