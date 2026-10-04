import '../shared/theme.css'
import './app.css'
import { render } from 'preact'
import { useState } from 'preact/hooks'
import { Gate } from './Gate'
import { Shell } from './Shell'
import { startEngine } from './store'
import type { Unlocked } from './identity'

// pick up an invite from the URL fragment, then clear it so it doesn't linger in history
const hash = location.hash
const initialJoin = hash.startsWith('#join=') ? location.href : undefined
if (initialJoin) history.replaceState(null, '', location.pathname + location.search)

function App() {
  const [ready, setReady] = useState(false)
  const [err, setErr] = useState('')
  const onReady = async (u: Unlocked) => {
    try {
      await startEngine(u)
      setReady(true)
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  if (err) return <div class="gate"><p class="error">{err}</p></div>
  return ready ? <Shell initialJoin={initialJoin} /> : <Gate onReady={onReady} />
}

render(<App />, document.getElementById('root')!)
