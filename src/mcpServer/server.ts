import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { createFetchTool, type FetchToolOptions, isPrivateHost } from '../tools/fetch'
import { createWebSearchTool } from '../tools/websearch'

const CATALOG_URL = 'https://botconnector.id/data/cloud-models.json'
const PRICING_URL = 'https://botconnector.id/data/payg-pricing.json'
const CACHE_TTL_MS = 60 * 60_000

export interface McpServerDeps {
  /** BotConnector API base, e.g. https://api.botconnector.id/v1 (no trailing slash). */
  baseUrl: string
  /** Bearer key for paid endpoints (bc_chat); never logged or echoed. */
  apiKey: string
  /** Default model id for bc_chat (provider prefix already stripped). */
  defaultModel: string
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch
  /** Injectable clock for the catalog cache; defaults to Date.now. */
  now?: () => number
  /** Keenable endpoint for bc_search fallback; undefined = the public keyless endpoint. */
  keenableURL?: string
  /** Passed to createFetchTool (DNS lookup / page fetch injection for tests). */
  fetchTool?: FetchToolOptions
}

interface CatalogModel {
  id: string
  context?: number | null
  access?: string
  status?: string
  capabilities?: string[]
}

interface TokenRate {
  id: string
  tiers?: { inputPerMTokensUsd?: number; outputPerMTokensUsd?: number }[]
}

const ctxLabel = (context: number | null | undefined): string => {
  if (!context || !Number.isFinite(context)) return '?'
  return context >= 1000 ? `${Math.round(context / 1000)}k` : String(context)
}

const usd = (v: number | undefined): string => (typeof v === 'number' ? `$${v}` : '?')

export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: 'botconnector', version: '0.1.0' })
  const fetchFn = deps.fetchFn ?? fetch
  const now = deps.now ?? Date.now
  let cache: { at: number; text: string } | undefined

  const searchTool = createWebSearchTool({
    botconnector: () => (deps.apiKey ? { baseURL: deps.baseUrl, apiKey: deps.apiKey } : undefined),
    keenableURL: deps.keenableURL,
  })
  const pageTool = createFetchTool(deps.fetchTool)
  const toolCtx = () => ({
    cwd: '.',
    signal: AbortSignal.timeout(30_000),
    readFiles: new Set<string>(),
  })

  server.registerTool(
    'bc_models',
    {
      description:
        'List BotConnector cloud models with context window and pay-as-you-go price (USD per 1M tokens).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (cache && now() - cache.at < CACHE_TTL_MS) {
        return { content: [{ type: 'text', text: cache.text }] }
      }
      const [catalogRes, pricingRes] = await Promise.all([fetchFn(CATALOG_URL), fetchFn(PRICING_URL)])
      if (!catalogRes.ok) throw new Error(`catalog HTTP ${catalogRes.status}`)
      const catalog = (await catalogRes.json()) as { models?: CatalogModel[] }
      const pricing = pricingRes.ok
        ? ((await pricingRes.json()) as { tokenRates?: TokenRate[] })
        : { tokenRates: [] }
      const rates = new Map<string, TokenRate>((pricing.tokenRates ?? []).map((r) => [r.id, r]))
      const lines = (catalog.models ?? []).map((m) => {
        const tier = rates.get(m.id)?.tiers?.[0]
        const price = tier ? `in ${usd(tier.inputPerMTokensUsd)}/M out ${usd(tier.outputPerMTokensUsd)}/M` : 'price n/a'
        const access = m.access ? ` · ${m.access}` : ''
        return `${m.id} · ctx ${ctxLabel(m.context)} · ${price}${access}`
      })
      const text = lines.length ? lines.join('\n') : 'No models in the catalog.'
      cache = { at: now(), text }
      return { content: [{ type: 'text', text }] }
    },
  )

  server.registerTool(
    'bc_search',
    {
      description:
        'Search the web and return ranked results (title, url, snippet). Use it to discover pages, then bc_fetch to read one.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('Search query'),
        max_results: z.number().int().min(1).max(8).optional().describe('Number of results (default 6)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, max_results }) => {
      const r = await searchTool.run({ query, max_results }, toolCtx())
      return { content: [{ type: 'text' as const, text: r.output }], ...(r.isError ? { isError: true } : {}) }
    },
  )

  server.registerTool(
    'bc_fetch',
    {
      description: 'Fetch a URL and return its text content (HTML tags stripped).',
      inputSchema: { url: z.string().min(1).describe('Absolute http(s) URL') },
      annotations: { readOnlyHint: true },
    },
    async ({ url }) => {
      if (!/^https?:\/\//i.test(url)) {
        return { content: [{ type: 'text' as const, text: 'URL must start with http:// or https://' }], isError: true }
      }
      let host: string
      try {
        host = new URL(url).hostname
      } catch {
        return { content: [{ type: 'text' as const, text: 'Invalid URL.' }], isError: true }
      }
      if (isPrivateHost(host)) {
        return {
          content: [{ type: 'text' as const, text: `Blocked: ${host} is a private host. bc_fetch only fetches public URLs.` }],
          isError: true,
        }
      }
      const r = await pageTool.run({ url }, toolCtx())
      return { content: [{ type: 'text' as const, text: r.output }], ...(r.isError ? { isError: true } : {}) }
    },
  )

  server.registerTool(
    'bc_chat',
    {
      description:
        'Send a prompt to a BotConnector model and get the reply. Returns the answer plus token usage. The model pays from the same API key.',
      inputSchema: {
        prompt: z.string().min(1).max(100_000).describe('The user message'),
        model: z.string().optional().describe('Model id (default: the configured model)'),
        max_tokens: z.number().int().min(1).max(4096).optional().describe('Reply budget (default 1024, max 4096)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ prompt, model, max_tokens }) => {
      const res = await fetchFn(`${deps.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.apiKey}` },
        body: JSON.stringify({
          model: model ?? deps.defaultModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: max_tokens ?? 1024,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string }
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      if (!res.ok) {
        const message = body.error?.message ?? `HTTP ${res.status}`
        return { content: [{ type: 'text' as const, text: `bc_chat failed: ${message}` }], isError: true }
      }
      const reply = body.choices?.[0]?.message?.content ?? ''
      const usage = body.usage
        ? `\n\n[usage: ${body.usage.prompt_tokens ?? 0} in / ${body.usage.completion_tokens ?? 0} out]`
        : ''
      return { content: [{ type: 'text' as const, text: reply + usage }] }
    },
  )

  return server
}
