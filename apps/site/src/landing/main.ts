import '../shared/theme.css'
import './landing.css'
import { wireThemeToggles } from '../shared/theme'
import { mountCouncil } from './council'

wireThemeToggles()

const svg = document.getElementById('council') as unknown as SVGSVGElement | null
if (svg) mountCouncil(svg)

// the live demo is loaded on demand: it connects to public relays only after the visitor asks
const demoRoot = document.getElementById('demo-root')
if (demoRoot) import('./demo').then((m) => m.mountDemo(demoRoot))
