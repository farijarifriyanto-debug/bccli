import { z } from 'zod'
import { defineTool, type Tool } from './types'

interface SearchResult {
  title: string
  url: string
  snippet: string
}

const clean = (items: unknown, max: number): SearchResult[] =>
  (Array.isArray(items) ? items : [])
    .filter((r) => typeof r?.url === 'string' && /^https?:\/\//.test(r.url))
    .slice(0, max)
    .map((r) => ({
      title: String(r.title || r.url).slice(0, 200),
      url: r.url,
      snippet: String(r.snippet || r.description || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600),
    }))

async function postJson(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export function createWebSearchTool(opts: {
  /** BotConnector Cloud endpoint + key, when the user has one; searches then go through our server. */
  botconnector: () => { baseURL: string; apiKey: string } | undefined
  keenableURL?: string
}): Tool {
  const keenableURL = opts.keenableURL ?? 'https://api.keenable.ai/v1/search/public'
  return defineTool({
    name: 'web_search',
    description:
      'Search the web. Returns titles, URLs and short snippets. Use it to find the right pages instead of guessing URLs; then fetch a result URL when you need the full page.',
    schema: z.object({
      query: z.string().min(1).max(500).describe('Search query'),
      max_results: z.number().int().min(1).max(10).optional().describe('Number of results (default 6)'),
    }),
    kind: 'read',
    target: (input) => input.query,
    parallelSafe: () => true,
    async run(input, ctx) {
      const max = input.max_results ?? 6
      const errors: string[] = []
      let results: SearchResult[] = []
      const bc = opts.botconnector()
      if (bc) {
        try {
          const data = (await postJson(`${bc.baseURL.replace(/\/+$/, '')}/web/search`, { query: input.query, max_results: max }, { authorization: `Bearer ${bc.apiKey}` }, ctx.signal)) as {
            results?: unknown
          }
          results = clean(data.results, max)
        } catch (error) {
          errors.push(`BotConnector: ${(error as Error).message}`)
        }
      }
      // Keenable's public API needs no key; LibreChat on app.botconnector.id uses the same.
      if (!results.length) {
        try {
          const data = (await postJson(keenableURL, { query: input.query }, { 'x-keenable-title': 'BotConnector' }, ctx.signal)) as { results?: unknown }
          results = clean(data.results, max)
        } catch (error) {
          errors.push(`Keenable: ${(error as Error).message}`)
        }
      }
      if (!results.length) {
        return { output: errors.length ? `Web search gagal (${errors.join('; ')}).` : 'Tidak ada hasil.', isError: errors.length > 0 }
      }
      const output = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n')
      return { output, display: `${results.length} hasil` }
    },
  })
}
