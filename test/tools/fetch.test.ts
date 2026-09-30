import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest'
import { clearFetchCache, createFetchTool, fetchTool, htmlToText, isPrivateHost, pickRelevant } from '../../src/tools/fetch'

const seen = { accept: '', hits: 0, keen: [] as { params: URLSearchParams; title: string }[] }
const filler = (n: number) => `<p>Paragraf pengisi nomor ${n} membahas hal lain sama sekali tentang cuaca, kebun, dan resep masakan rumah.</p>`
const server = createServer((req, res) => {
  if (req.url?.startsWith('/v1/fetch/public')) {
    const params = new URL(req.url, 'http://x').searchParams
    seen.keen.push({ params, title: String(req.headers['x-keenable-title']) })
    if (params.get('url')?.endsWith('/nokeen')) {
      res.statusCode = 500
      return res.end('boom')
    }
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ content: `EXTRACTED for ${params.get('prompt')}` }))
  }
  if (req.url === '/md') {
    seen.accept = String(req.headers.accept)
    res.setHeader('content-type', 'text/markdown; charset=utf-8')
    res.end('# Judul\n\n**tebal** <script>tetap</script>')
  } else if (req.url === '/long') {
    seen.hits++
    res.setHeader('content-type', 'text/plain')
    res.end(Array.from({ length: 3000 }, (_, i) => `${String(i).padStart(9, '0')}\n`).join(''))
  } else if (req.url === '/doc' || req.url === '/nokeen') {
    res.setHeader('content-type', 'text/html')
    const paras = Array.from({ length: 40 }, (_, i) => filler(i))
    paras.splice(20, 0, '<p>Harga paket: Starter 9 dolar per bulan, Pro 29 dolar per bulan.</p>')
    res.end(`<html><body>${paras.join('')}</body></html>`)
  } else if (req.url === '/html') {
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
beforeEach(() => {
  clearFetchCache()
  seen.hits = 0
  seen.keen = []
})
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
  expect(r.output.length).toBeLessThan(13_000)
  expect(r.output).toContain('dipotong')
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

test('asks for markdown and uses a markdown response as is', async () => {
  const r = await fetchTool.run({ url: `${base}/md` }, ctx)
  expect(seen.accept).toContain('text/markdown')
  expect(r.output).toBe('# Judul\n\n**tebal** <script>tetap</script>')
})

test('a page is capped at 12k characters and offset reads the next slice', async () => {
  const first = await fetchTool.run({ url: `${base}/long` }, ctx)
  expect(first.output.startsWith('000000000\n')).toBe(true)
  expect(first.output.length).toBeLessThan(12_500)
  expect(first.output).toContain('offset=12000')
  const next = await fetchTool.run({ url: `${base}/long`, offset: 12_000 }, ctx)
  expect(next.output.startsWith('000001200\n')).toBe(true)
  const past = await fetchTool.run({ url: `${base}/long`, offset: 99_999 }, ctx)
  expect(past.isError).toBe(true)
  expect(past.output).toContain('30000')
})

test('reopening the same URL is served from the session cache', async () => {
  await fetchTool.run({ url: `${base}/long` }, ctx)
  const again = await fetchTool.run({ url: `${base}/long`, offset: 12_000 }, ctx)
  expect(seen.hits).toBe(1)
  expect(again.display).toContain('cache')
})

test('the result shows what the fetch cost in tokens', async () => {
  const r = await fetchTool.run({ url: `${base}/long` }, ctx)
  expect(r.display).toMatch(/~\d+ token/)
})

test('prompt asks Keenable to extract just what is needed', async () => {
  const tool = createFetchTool({ keenableURL: `${base}/v1/fetch/public`, isPrivate: () => false })
  const r = await tool.run({ url: `${base}/doc`, prompt: 'berapa harga paket' }, ctx)
  expect(r.output).toContain('EXTRACTED for berapa harga paket')
  expect(seen.keen).toHaveLength(1)
  expect(seen.keen[0].title).toBe('BotConnector')
  expect(seen.keen[0].params.get('url')).toBe(`${base}/doc`)
  expect(seen.keen[0].params.get('live')).toBe('true')
  expect(r.display).toContain('Keenable')
})

test('when Keenable fails the local BM25 excerpt still finds the relevant paragraph', async () => {
  const tool = createFetchTool({ keenableURL: `${base}/v1/fetch/public`, isPrivate: () => false })
  const r = await tool.run({ url: `${base}/nokeen`, prompt: 'harga paket Starter Pro' }, ctx)
  expect(r.isError).toBeUndefined()
  expect(r.output).toContain('Starter 9 dolar')
  expect(r.output.length).toBeLessThan(3_500)
  expect(r.display).toContain('lokal')
})

test('private/intranet URLs are never sent to Keenable', async () => {
  const tool = createFetchTool({ keenableURL: `${base}/v1/fetch/public` })
  const r = await tool.run({ url: `${base}/doc`, prompt: 'harga paket Starter' }, ctx)
  expect(seen.keen).toHaveLength(0)
  expect(r.output).toContain('Starter 9 dolar')
  const off = createFetchTool({ keenableURL: null, isPrivate: () => false })
  await off.run({ url: `${base}/doc`, prompt: 'harga' }, ctx)
  expect(seen.keen).toHaveLength(0)
})

test('isPrivateHost', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.1.1', '169.254.169.254', 'intranet', 'nas.local', 'wiki.internal', '::1', '[fd00::1]']) {
    expect(isPrivateHost(h), h).toBe(true)
  }
  for (const h of ['example.com', 'docs.keenable.ai', '8.8.8.8', '172.32.0.1']) expect(isPrivateHost(h), h).toBe(false)
})

test('pickRelevant returns the best chunks in page order, or null when nothing matches', () => {
  const text = Array.from({ length: 50 }, (_, i) => (i === 30 ? 'kolam renang dibuka jam 6 pagi' : `baris biasa ${i} tentang kebun`)).join('\n')
  expect(pickRelevant(text, 'jam buka kolam renang')).toContain('kolam renang dibuka jam 6 pagi')
  expect(pickRelevant(text, 'zzzz qqqq')).toBeNull()
})
