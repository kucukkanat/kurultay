import '../shared/theme.css'
import './docs.css'
import { wireThemeToggles } from '../shared/theme'

wireThemeToggles()
for (const pre of document.querySelectorAll<HTMLPreElement>('.prose pre')) {
  const b = document.createElement('button')
  b.className = 'copy'
  b.type = 'button'
  b.textContent = 'Copy'
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.innerText.replace(/Copy$/, '').trim())
      b.textContent = 'Copied'
    } catch {
      b.textContent = 'Select and copy'
    }
    setTimeout(() => (b.textContent = 'Copy'), 1500)
  })
  pre.append(b)
}
