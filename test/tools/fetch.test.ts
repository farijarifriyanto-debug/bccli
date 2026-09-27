import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { fetchTool, htmlToText } from '../../src/tools/fetch'

const server = createServer((req, res) => {
  if (req.url === '/html') {
    res.setHeader('content-type', 'text/html')
    res.end('<html><head><style>x{}</style><script>evil()</script></head><body><h1>Hi &amp; bye</h1><p>para</p></body></html>')
  } else if (req.url === '/big') {
    res.setHeader('content-type', 'text/plain')
    res.end('x'.repeat(10 * 1024 * 1024))
  } else if (req.url === '/away') {
    res.statusCode = 302
    res.setHeader('location', `http://localhost:${(server.address() as AddressInfo).port}/html`)
    res.end()
  } else if (req.url === '/same') {
    res.statusCode = 302
    res.setHeader('location', '/html')
    res.end()
  } else if (req.url === '/gone') {
    res.statusCode = 404
    res.setHeader('content-type', 'text/html')
    res.end('<!DOCTYPE html><html><head><script>x()</script></head><body><h1>Page not found</h1></body></html>')
  } else {
    res.statusCode = 404
    res.end('missing')
  }
})
let base = ''
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
const ctx = { cwd: '.', signal: new AbortController().signal, readFiles: new Set<string>() }

test('htmlToText drops scripts/styles and decodes entities', () => {
  expect(htmlToText('<style>a</style><script>b</script><p>x &amp; y</p><p>z</p>')).toBe('x & y\nz')
})

test('fetch converts HTML to text', async () => {
  const r = await fetchTool.run({ url: `${base}/html` }, ctx)
  expect(r.output).toContain('Hi & bye')
  expect(r.output).not.toContain('evil')
})

test('fetch reports HTTP errors', async () => {
  const r = await fetchTool.run({ url: `${base}/nope` }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toContain('404')
})

test('fetch stops reading huge responses', async () => {
  const r = await fetchTool.run({ url: `${base}/big` }, ctx)
  expect(r.output.length).toBeLessThan(60_000)
  expect(r.output).toContain('[dipotong]')
  expect(r.display).toMatch(/lebih dari 5 MB/)
})

test('fetch follows same-host redirects but not redirects to another host', async () => {
  expect((await fetchTool.run({ url: `${base}/same` }, ctx)).output).toContain('Hi & bye')
  const away = await fetchTool.run({ url: `${base}/away` }, ctx)
  expect(away.isError).toBe(true)
  expect(away.output).toContain('localhost')
})

test('an HTML error page is reported as text, not markup', async () => {
  const r = await fetchTool.run({ url: `${base}/gone` }, ctx)
  expect(r.output).toBe(`HTTP 404 dari ${base}/gone: Page not found`)
})

test('a network failure names its cause instead of just "fetch failed"', async () => {
  const r = await fetchTool.run({ url: 'http://nama-host-tidak-ada.invalid/' }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toContain('ENOTFOUND')
  expect(r.output).toContain('DNS')
})
