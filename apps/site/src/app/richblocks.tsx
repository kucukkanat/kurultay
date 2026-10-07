import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { CodeBlockRenderer } from './markdown'
import { artifactDocument, artifactTitle, chartSvg, checkSvg, clampHeight, isHeightMsg, RichError, svgDataUrl } from './rich'
import { isDark } from '../shared/theme'

/**
 * Fenced code blocks shown as more than code: diagrams (`mermaid`), charts (`vega-lite`), pictures (`svg`) and interactive
 * pages (`artifact`). Drawings become an SVG picture shown with <img>, so nothing an author writes is ever put into the page as
 * markup; artifacts run in a frame that cannot reach the page. The drawing libraries load on first use.
 */

let counter = 0
// mermaid and vega keep global state: one render at a time
let queue: Promise<unknown> = Promise.resolve()
const alone = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

function download(name: string, svg: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function Frame({ kind, title, source, svg, children }: { kind: string; title: string; source: string; svg?: string; children: ComponentChildren }) {
  const [showSource, setShowSource] = useState(false)
  return (
    <figure class="md-rich" data-testid={`rich-${kind}`}>
      <div class="md-rich-bar">
        <span>{title}</span>
        <span class="md-rich-actions">
          {svg && (
            <button class="link-btn" type="button" onClick={() => download(`${kind}.svg`, svg)} data-testid="rich-download">
              Download .svg
            </button>
          )}
          <button class="link-btn" type="button" onClick={() => setShowSource((s) => !s)} aria-pressed={showSource} data-testid="rich-source-toggle">
            {showSource ? 'Hide source' : 'View source'}
          </button>
        </span>
      </div>
      {children}
      {showSource && (
        <pre class="md-rich-source" data-testid="rich-source">
          <code>{source}</code>
        </pre>
      )}
    </figure>
  )
}

const Failed = ({ kind, error, source }: { kind: string; error: string; source: string }) => (
  <Frame kind={kind} title={`${kind} (could not be drawn)`} source={source}>
    <p class="error" data-testid="rich-error">{error}</p>
    <pre class="md-rich-source">
      <code>{source}</code>
    </pre>
  </Frame>
)

const messageOf = (err: unknown): string => (err instanceof Error && err.message) || 'It could not be drawn'

/** Draws to an SVG string with a lazily loaded library; again when the code or the theme changes. */
function useDrawing(draw: () => Promise<string>, deps: unknown[]): { svg?: string; error?: string } {
  const [state, set] = useState<{ svg?: string; error?: string }>({})
  useEffect(() => {
    let live = true
    set({})
    alone(draw).then(
      (svg) => live && set({ svg }),
      (err: unknown) => live && set({ error: messageOf(err) }),
    )
    return () => {
      live = false
    }
  }, deps)
  return state
}

function Drawn({ kind, title, code, drawing }: { kind: string; title: string; code: string; drawing: { svg?: string; error?: string } }) {
  if (drawing.error) return <Failed kind={kind} error={drawing.error} source={code} />
  return (
    <Frame kind={kind} title={title} source={code} svg={drawing.svg}>
      {drawing.svg ? <img class="md-rich-img" src={svgDataUrl(drawing.svg)} alt={title} data-testid="rich-drawing" /> : <p class="muted md-rich-wait">Drawing…</p>}
    </Frame>
  )
}

const MermaidBlock: CodeBlockRenderer = ({ code }) => {
  const dark = isDark()
  const drawing = useDrawing(async () => {
    const mermaid = (await import('mermaid')).default
    // strict keeps mermaid's own sanitiser on; plain SVG text labels also render reliably inside an <img>
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', flowchart: { htmlLabels: false }, fontFamily: 'system-ui, sans-serif' })
    return (await mermaid.render(`kurultay-mermaid-${++counter}`, code)).svg
  }, [code, dark])
  return <Drawn kind="mermaid" title="Diagram" code={code} drawing={drawing} />
}

const ChartBlock: CodeBlockRenderer = ({ code }) => {
  const dark = isDark()
  const drawing = useDrawing(() => {
    // the chart follows the app's tokens, read at draw time so a theme switch redraws in the new colours
    const css = getComputedStyle(document.documentElement)
    return chartSvg(code, { ink: css.getPropertyValue('--ink').trim() || 'currentColor', grid: css.getPropertyValue('--line').trim() || 'currentColor' })
  }, [code, dark])
  return <Drawn kind="vega-lite" title="Chart" code={code} drawing={drawing} />
}

const SvgBlock: CodeBlockRenderer = ({ code }) => {
  try {
    const svg = checkSvg(code)
    return <Drawn kind="svg" title="Picture" code={code} drawing={{ svg }} />
  } catch (err) {
    if (!(err instanceof RichError)) throw err
    return <Failed kind="svg" error={err.message} source={code} />
  }
}

/**
 * A small interactive page. It does nothing until the reader presses Run, then runs in a frame whose policy allows no network,
 * no storage, no navigation and no contact with this page (see rich.ts). The only thing it can tell us is its height.
 */
function ArtifactRunner({ html, title, onStop }: { html: string; title: string; onStop: () => void }) {
  const [height, setHeight] = useState(clampHeight(undefined))
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    const on = (ev: MessageEvent) => {
      if (ev.source === frame.current?.contentWindow && isHeightMsg(ev.data)) setHeight(clampHeight(ev.data.h))
    }
    addEventListener('message', on)
    return () => removeEventListener('message', on)
  }, [])
  return (
    <>
      <iframe ref={frame} class="md-artifact" title={title} sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc={artifactDocument(html)} style={{ height: `${height}px` }} data-testid="artifact-frame" />
      <div class="row">
        <button class="btn small" type="button" onClick={onStop} data-testid="artifact-stop">
          Stop
        </button>
        <span class="member-meta">Runs on its own: no network, no access to this page.</span>
      </div>
    </>
  )
}

const ArtifactBlock: CodeBlockRenderer = ({ code }) => {
  const [running, setRunning] = useState(false)
  const title = artifactTitle(code)
  return (
    <Frame kind="artifact" title={title} source={code}>
      {running ? (
        <ArtifactRunner html={code} title={title} onStop={() => setRunning(false)} />
      ) : (
        <div class="md-artifact-card">
          <span class="member-meta">An interactive page from the sender. It only runs if you press Run.</span>
          <button class="btn small primary" type="button" onClick={() => setRunning(true)} data-testid="artifact-run">
            Run
          </button>
        </div>
      )}
    </Frame>
  )
}

export const richBlocks = { mermaid: MermaidBlock, 'vega-lite': ChartBlock, svg: SvgBlock, artifact: ArtifactBlock } as const satisfies Record<string, CodeBlockRenderer>
export type BlockLang = keyof typeof richBlocks
