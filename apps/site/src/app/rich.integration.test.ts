// Integration: charts drawn with the real vega and vega-lite packages, headless (renderer 'none', straight to an SVG string).
import { expect, test } from 'bun:test'
import { chartSvg, RichError } from './rich'

const colors = { ink: '#2a1e17', grid: 'rgba(42, 30, 23, 0.14)' }

test('a bar chart becomes an SVG picture in the given colours', async () => {
  const spec = { data: { values: [{ team: 'api', open: 12 }, { team: 'web', open: 7 }] }, mark: 'bar', encoding: { x: { field: 'team', type: 'nominal' }, y: { field: 'open', type: 'quantitative' } } }
  const svg = await chartSvg(JSON.stringify(spec), colors)
  expect(svg).toStartWith('<svg')
  expect(svg).toContain('#2a1e17')
  expect(svg).toContain('api')
})

test('a chart that names a url is refused before anything is drawn', async () => {
  const err = await chartSvg('{"data":{"url":"https://example.com/d.csv"},"mark":"bar"}', colors).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(RichError)
  expect(err instanceof RichError && err.kind).toBe('url')
})

test('a broken spec fails with the reason', async () => {
  expect(chartSvg('{"mark":', colors)).rejects.toThrow('not valid JSON')
})

// a peer's spec runs as soon as its message is shown: its expressions must be interpreted, never compiled into functions
test('chart expressions run without Function(), and cannot reach globals', async () => {
  const real = globalThis.Function
  let compiled = 0
  globalThis.Function = new Proxy(real, { apply: (t, self, args) => (compiled++, Reflect.apply(t, self, args)), construct: (t, args) => (compiled++, Reflect.construct(t, args)) })
  try {
    const spec = { data: { values: [{ a: 1 }, { a: 2 }] }, transform: [{ calculate: 'datum.a * 2', as: 'b' }, { filter: 'datum.b > 2' }], mark: 'bar', encoding: { x: { field: 'b', type: 'quantitative' } } }
    expect(await chartSvg(JSON.stringify(spec), colors)).toStartWith('<svg')
  } finally {
    globalThis.Function = real
  }
  expect(compiled).toBe(0)

  const escape = { data: { values: [{ a: 1 }] }, transform: [{ calculate: "datum.constructor.constructor('globalThis.kurultayPwned = 1')()", as: 'x' }], mark: 'point' }
  await chartSvg(JSON.stringify(escape), colors).catch(() => undefined)
  expect('kurultayPwned' in globalThis).toBe(false)
})
