import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createMcpServer, type McpServerDeps } from '../src/mcpServer/server'

async function connected(deps: Partial<McpServerDeps> = {}) {
  const server = createMcpServer({
    baseUrl: 'https://api.test/v1',
    apiKey: 'k-test',
    defaultModel: 'glm-5.3-flash',
    ...deps,
  })
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '1' })
  await Promise.all([client.connect(clientT), server.connect(serverT)])
  return client
}

const catalogJson = JSON.stringify({
  models: [{ id: 'glm-5.3-flash', context: 128000, access: 'paid', status: 'available', capabilities: ['chat'] }],
})
const pricingJson = JSON.stringify({
  tokenRates: [{ id: 'glm-5.3-flash', tiers: [{ inputPerMTokensUsd: 0.6, outputPerMTokensUsd: 2.2 }] }],
})

function catalogFetch(counter: { calls: number }): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    counter.calls++
    const url = String(input)
    return new Response(url.includes('cloud-models') ? catalogJson : pricingJson)
  }) as typeof fetch
}

test('bc_models lists catalog models with context and price, cached for an hour', async () => {
  const counter = { calls: 0 }
  let clock = 0
  const client = await connected({ fetchFn: catalogFetch(counter), now: () => clock })
  const { tools } = await client.listTools()
  expect(tools.map((t) => t.name)).toContain('bc_models')
  expect(tools[0].inputSchema).toMatchObject({ type: 'object' })

  const out = (await client.callTool({ name: 'bc_models', arguments: {} })) as {
    content: { type: string; text: string }[]
  }
  const text = out.content.map((c) => c.text).join('\n')
  expect(text).toContain('glm-5.3-flash')
  expect(text).toContain('128k')
  expect(text).toContain('$0.6')
  expect(text).toContain('$2.2')
  expect(counter.calls).toBe(2)

  await client.callTool({ name: 'bc_models', arguments: {} })
  expect(counter.calls, 'second call hits the cache').toBe(2)

  clock += 60 * 60_000 + 1
  await client.callTool({ name: 'bc_models', arguments: {} })
  expect(counter.calls, 'cache expires after an hour').toBe(4)
})

const calls: { path: string; auth?: string }[] = []
let searchStatus = 200
const stub = createServer((req, res) => {
  calls.push({ path: req.url ?? '', auth: req.headers.authorization as string | undefined })
  res.setHeader('content-type', 'application/json')
  if (req.url === '/v1/web/search') {
    res.statusCode = searchStatus
    res.end(JSON.stringify({ provider: 'bc', results: [{ title: 'Hasil BC', url: 'https://a.id/1', snippet: 'snippet satu' }] }))
  } else if (req.url === '/page') {
    res.setHeader('content-type', 'text/html')
    res.end('<html><body><h1>Judul</h1><p>Isi halaman.</p></body></html>')
  } else {
    res.end(JSON.stringify({ results: [] }))
  }
})
let stubBase = ''
beforeAll(async () => {
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
})
afterAll(() => stub.close())

test('bc_search goes through BotConnector first, then reports failures as tool errors', async () => {
  calls.length = 0
  searchStatus = 200
  const client = await connected({ baseUrl: `${stubBase}/v1`, keenableURL: `${stubBase}/keenable` })
  const ok = (await client.callTool({ name: 'bc_search', arguments: { query: 'harga rtx', max_results: 3 } })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  expect(ok.isError).toBeFalsy()
  expect(ok.content[0].text).toContain('1. Hasil BC')
  expect(calls[0]).toMatchObject({ path: '/v1/web/search', auth: 'Bearer k-test' })

  calls.length = 0
  searchStatus = 500
  const dead = await connected({ baseUrl: `${stubBase}/v1`, keenableURL: 'http://127.0.0.1:1/none' })
  const bad = (await dead.callTool({ name: 'bc_search', arguments: { query: 'x' } })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  expect(bad.isError).toBe(true)
  expect(bad.content[0].text).toMatch(/failed/i)
})

test('bc_fetch returns clean text and rejects private hosts', async () => {
  const client = await connected({
    fetchTool: {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchPage: async () =>
        new Response('<html><body><h1>Judul</h1><p>Isi halaman.</p></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    },
  })
  const out = (await client.callTool({ name: 'bc_fetch', arguments: { url: 'https://example.com/page' } })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  expect(out.isError).toBeFalsy()
  expect(out.content[0].text).toContain('Judul')
  expect(out.content[0].text).toContain('Isi halaman.')

  const blocked = (await client.callTool({ name: 'bc_fetch', arguments: { url: 'http://localhost/admin' } })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  expect(blocked.isError).toBe(true)
})

test('bc_chat calls chat completions, reports usage, and caps max_tokens', async () => {
  const seen: { url: string; auth?: string; body: Record<string, unknown> }[] = []
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      auth: (init?.headers as Record<string, string>)?.authorization,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    })
    if (seen.length === 3) {
      return new Response(JSON.stringify({ error: { message: 'billing limit reached' } }), { status: 402 })
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Halo!' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    )
  }) as typeof fetch
  const client = await connected({ fetchFn })

  const out = (await client.callTool({ name: 'bc_chat', arguments: { prompt: 'hai' } })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  expect(out.isError).toBeFalsy()
  expect(out.content[0].text).toContain('Halo!')
  expect(out.content[0].text).toContain('[usage: 5 in / 2 out]')
  expect(seen[0].url).toBe('https://api.test/v1/chat/completions')
  expect(seen[0].auth).toBe('Bearer k-test')
  expect(seen[0].body).toMatchObject({ model: 'glm-5.3-flash', max_tokens: 1024, stream: false })

  await client.callTool({ name: 'bc_chat', arguments: { prompt: 'x', model: 'gpt-6-luna' } })
  expect(seen[1].body).toMatchObject({ model: 'gpt-6-luna' })

  const tooBig = (await client.callTool({ name: 'bc_chat', arguments: { prompt: 'x', max_tokens: 99999 } })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  expect(tooBig.isError).toBe(true)
  expect(tooBig.content[0].text).toContain('4096')

  const failed = (await client.callTool({ name: 'bc_chat', arguments: { prompt: 'x' } })) as {
    content: { type: string; text: string }[]
    isError?: boolean
  }
  expect(failed.isError).toBe(true)
  expect(failed.content[0].text).toContain('billing limit reached')
})
