import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, test } from 'vitest'
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
  expect(tools.map((t) => t.name)).toEqual(['bc_models'])
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
