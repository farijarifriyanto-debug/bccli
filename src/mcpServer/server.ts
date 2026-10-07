import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

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

  return server
}
