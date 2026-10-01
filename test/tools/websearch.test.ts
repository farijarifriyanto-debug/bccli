import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createWebSearchTool } from '../../src/tools/websearch'

const calls: { path: string; auth?: string; title?: string; body: string }[] = []
let botconnectorStatus = 200
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    calls.push({ path: req.url ?? '', auth: req.headers.authorization, title: req.headers['x-keenable-title'] as string, body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/web/search') {
      res.statusCode = botconnectorStatus
      res.end(JSON.stringify({ provider: 'exa', results: [{ title: 'Dari BotConnector', url: 'https://a.id/1', snippet: 'harga 15 juta' }] }))
    } else {
      res.end(JSON.stringify({ results: [{ title: 'Dari Keenable', url: 'https://b.id/2', description: '  harga\n 16 juta ' }] }))
    }
  })
})
let base = ''
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
const ctx = { cwd: '.', signal: new AbortController().signal, readFiles: new Set<string>() }

test('searches through BotConnector with the account key', async () => {
  calls.length = 0
  botconnectorStatus = 200
  const tool = createWebSearchTool({ botconnector: () => ({ baseURL: `${base}/v1`, apiKey: 'bc_live_x' }), keenableURL: `${base}/keenable` })
  const r = await tool.run({ query: 'harga rtx 5070 ti' }, ctx)
  expect(r.output).toContain('1. Dari BotConnector\n   https://a.id/1\n   harga 15 juta')
  expect(calls).toMatchObject([{ path: '/v1/web/search', auth: 'Bearer bc_live_x' }])
  expect(JSON.parse(calls[0].body)).toEqual({ query: 'harga rtx 5070 ti', max_results: 6 })
})

test('falls back to Keenable when BotConnector has no search endpoint or no key', async () => {
  calls.length = 0
  botconnectorStatus = 404
  const tool = createWebSearchTool({ botconnector: () => ({ baseURL: `${base}/v1`, apiKey: 'bc_live_x' }), keenableURL: `${base}/keenable` })
  const r = await tool.run({ query: 'rtx' }, ctx)
  expect(r.output).toContain('1. Dari Keenable\n   https://b.id/2\n   harga 16 juta')
  expect(calls.map((c) => c.path)).toEqual(['/v1/web/search', '/keenable'])
  expect(calls[1].title).toBe('BotConnector')
  const noKey = createWebSearchTool({ botconnector: () => undefined, keenableURL: `${base}/keenable` })
  expect((await noKey.run({ query: 'rtx' }, ctx)).output).toContain('Dari Keenable')
})

test('reports a clear error when every provider fails', async () => {
  const tool = createWebSearchTool({ botconnector: () => undefined, keenableURL: 'http://127.0.0.1:1/none' })
  const r = await tool.run({ query: 'rtx' }, ctx)
  expect(r.isError).toBe(true)
  expect(r.output).toMatch(/Web search failed/)
})
