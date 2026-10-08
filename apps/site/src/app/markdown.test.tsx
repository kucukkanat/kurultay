// Integration: Markdown with the real rich blocks, rendered to a string (effects do not run, so nothing is drawn or loaded).
// happy-dom only answers the theme lookup (isDark); registered for this file so the packages tests keep Bun's own globals.
import { registerDom, unregisterDom } from './dom-env'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { render } from 'preact-render-to-string'
import { Markdown } from './markdown'
import { richBlocks } from './richblocks'

beforeAll(() => registerDom())
afterAll(() => unregisterDom())

const names = new Set(['ada', 'scout'])
const html = (text: string, maxSpecial?: number) => render(<Markdown text={text} names={names} blocks={richBlocks} maxSpecial={maxSpecial} />)
const count = (s: string, needle: string) => s.split(needle).length - 1

test('HTML written in a message comes out as text', () => {
  const out = html('hi <script>alert(1)</script> and <img src=x onerror=alert(1)>\n\n<div onclick="x()">block</div>')
  expect(out).not.toContain('<script')
  expect(out).not.toContain('<img')
  expect(out).not.toContain('<div onclick')
  expect(out).toContain('&lt;script>')
  expect(out).toContain('&lt;img src=x onerror=alert(1)>')
})

test('unsafe links become plain spans, safe ones open in a new tab', () => {
  const out = html('[x](javascript:alert(1)) [y](https://example.com) ![p](http://example.com/a.png)')
  expect(out).not.toContain('javascript:')
  expect(out).toContain('<span>x</span>')
  expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">y</a>')
  expect(out).toContain('<a href="http://example.com/a.png"')
  expect(out).not.toContain('<img')
})

test('https images load without a referrer and without a CORS request most hosts would refuse', () => {
  const out = html('![chart](https://example.com/a.png)')
  expect(out).toContain('<img class="md-img" src="https://example.com/a.png"')
  expect(out).toContain('referrerpolicy="no-referrer"')
  expect(out).not.toContain('crossorigin')
})

test('tables, task lists, mentions, headings and line breaks', () => {
  const out = html('# Title\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n3. three\n\n@ada and @nobody, @all\nnext line ~~gone~~')
  expect(out).toContain('<h3 class="md-h">Title</h3>')
  expect(out).toContain('<th style="text-align:left;">a</th>')
  expect(out).toContain('<td style="text-align:right;">2</td>')
  expect(out).toContain('<li class="md-task"><input type="checkbox" checked disabled aria-label="done"/>done</li>')
  expect(out).toContain('<ol start="3">')
  expect(out).toContain('<span class="mention">@ada</span>')
  expect(out).toContain('<span class="mention">@all</span>')
  expect(out).not.toContain('<span class="mention">@nobody</span>')
  expect(out).toContain('<br/>next line <del>gone</del>')
})

test('plain fenced code has a copy button', () => {
  const out = html('```ts\nconst a = 1 < 2\n```')
  expect(out).toContain('data-testid="md-code"')
  expect(out).toContain('data-testid="md-code-copy"')
  expect(out).toContain('const a = 1 &lt; 2')
})

test('an artifact shows only a Run card until it is pressed', () => {
  const out = html('```artifact\n<title>Counter</title><script>alert(1)</script>\n```')
  expect(out).toContain('data-testid="rich-artifact"')
  expect(out).toContain('data-testid="artifact-run"')
  expect(out).toContain('Counter')
  expect(out).not.toContain('<iframe')
  expect(out).not.toContain('<script')
})

test('an svg block is a data: picture, never inline svg', () => {
  const out = html('```svg\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n```')
  expect(out).toContain('data-testid="rich-svg"')
  expect(out).toContain('src="data:image/svg+xml;charset=utf-8,%3Csvg')
  expect(out).not.toContain('<svg')
  expect(out).not.toContain('<script')
})

test('a block that cannot be drawn shows why, with its source', () => {
  const out = html('```svg\n<html>no</html>\n```')
  expect(out).toContain('data-testid="rich-error"')
  expect(out).toContain('&lt;html>no&lt;/html>')
})

test('mermaid and vega-lite wait for their libraries; nothing is drawn while rendering', () => {
  const out = html('```mermaid\ngraph LR; A-->B\n```\n```Vega-Lite\n{"mark":"bar"}\n```')
  expect(out).toContain('data-testid="rich-mermaid"')
  expect(out).toContain('data-testid="rich-vega-lite"')
  expect(out).toContain('Drawing…')
})

test('only maxSpecial blocks are drawn per message; the rest stay code', () => {
  const out = html(Array.from({ length: 9 }, () => '```svg\n<svg></svg>\n```').join('\n\n'), 3)
  expect(count(out, 'data-testid="rich-svg"')).toBe(3)
  expect(count(out, 'data-testid="md-code"')).toBe(6)
})
