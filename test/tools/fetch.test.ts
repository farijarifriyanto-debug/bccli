import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { fetchTool, htmlToText } from '../../src/tools/fetch'

const server = createServer((req, res) => {
  if (req.url === '/html') {
    res.setHeader('content-type', 'text/html')
    res.end('<html><head><style>x{}</style><script>evil()</script></head><body><h1>Hi &amp; bye</h1><p>para</p></body></html>')
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
