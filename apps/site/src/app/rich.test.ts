import { describe, expect, test } from 'bun:test'
import { ARTIFACT_CSP, artifactDocument, artifactTitle, checkChartSpec, checkSvg, clampHeight, isHeightMsg, MAX_FRAME, MIN_FRAME, RichError, safeHref, safeImageSrc, svgDataUrl } from './rich'

const kindOf = (f: () => unknown): string => {
  try {
    f()
  } catch (err) {
    if (err instanceof RichError) return err.kind
    throw err
  }
  return 'none'
}

describe('checkChartSpec', () => {
  test('accepts a spec with inline values', () => {
    const spec = checkChartSpec('{"data":{"values":[{"a":1}]},"mark":"bar"}')
    expect(spec.mark).toBe('bar')
  })
  test('refuses a url wherever it is', () => {
    expect(kindOf(() => checkChartSpec('{"data":{"url":"https://x.test/d.csv"},"mark":"bar"}'))).toBe('url')
    expect(kindOf(() => checkChartSpec('{"layer":[{"mark":"image","encoding":{"url":{"value":"https://x.test/a.png"}}}]}'))).toBe('url')
    expect(kindOf(() => checkChartSpec('{"hconcat":[{"mark":"bar"},{"data":{"url":"d.json"}}]}'))).toBe('url')
  })
  test('refuses what is not a JSON object, or is nested too deeply', () => {
    expect(kindOf(() => checkChartSpec('{nope'))).toBe('json')
    expect(kindOf(() => checkChartSpec('[1,2]'))).toBe('shape')
    expect(kindOf(() => checkChartSpec('"bar"'))).toBe('shape')
    expect(kindOf(() => checkChartSpec('null'))).toBe('shape')
    expect(kindOf(() => checkChartSpec(`{"a":${'['.repeat(45)}${']'.repeat(45)}}`))).toBe('depth')
  })
})

describe('artifacts', () => {
  test('the policy comes before anything the author wrote, and refresh and base tags are dropped', () => {
    const doc = artifactDocument('<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/"><p>hi</p>')
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<p>hi</p>'))
    expect(doc).not.toContain('refresh')
    expect(doc).not.toContain('<base')
    expect(doc).toContain("kurultay:'height'")
  })
  test('the policy allows no network source', () => {
    expect(ARTIFACT_CSP).toStartWith("default-src 'none'")
    expect(ARTIFACT_CSP).not.toContain('http')
    expect(ARTIFACT_CSP).not.toContain('*')
  })
  test('title comes from <title>, with a fallback', () => {
    expect(artifactTitle('<title> Counter </title><b>x</b>')).toBe('Counter')
    expect(artifactTitle('<b>x</b>')).toBe('Interactive artifact')
  })
  test('height is clamped and junk falls back', () => {
    expect(clampHeight(10)).toBe(MIN_FRAME)
    expect(clampHeight(99_999)).toBe(MAX_FRAME)
    expect(clampHeight(300.2)).toBe(301)
    expect(clampHeight(Number.NaN)).toBe(MIN_FRAME * 2)
    expect(clampHeight('500')).toBe(MIN_FRAME * 2)
  })
  test('only height messages are recognised', () => {
    expect(isHeightMsg({ kurultay: 'height', h: 200 })).toBe(true)
    expect(isHeightMsg({ fika: 'height', h: 200 })).toBe(false)
    expect(isHeightMsg('height')).toBe(false)
  })
})

test('checkSvg accepts svg documents only', () => {
  expect(checkSvg('  <svg viewBox="0 0 1 1"></svg> ')).toBe('<svg viewBox="0 0 1 1"></svg>')
  expect(checkSvg('<?xml version="1.0"?>\n<svg></svg>')).toStartWith('<?xml')
  expect(kindOf(() => checkSvg('<html><svg></svg></html>'))).toBe('svg')
  expect(kindOf(() => checkSvg('<svgfoo>'))).toBe('svg')
  expect(svgDataUrl('<svg/>')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E')
})

test('safeHref allows http, https and mailto only', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '/relative', '', null, undefined]) expect(safeHref(bad)).toBeNull()
  expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  expect(safeHref(' http://example.com ')).toBe('http://example.com')
  expect(safeHref('mailto:a@example.com')).toBe('mailto:a@example.com')
})

test('safeImageSrc allows https and small raster data', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='
  expect(safeImageSrc('https://example.com/a.png')).toBe('https://example.com/a.png')
  expect(safeImageSrc(png)).toBe(png)
  expect(safeImageSrc('http://example.com/a.png')).toBeNull()
  expect(safeImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
  expect(safeImageSrc(`data:image/png;base64,${'A'.repeat(400_000)}`)).toBeNull()
  expect(safeImageSrc('javascript:alert(1)')).toBeNull()
})
