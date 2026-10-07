import { lookup as dnsCbLookup } from 'node:dns'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { z } from 'zod'
import { defineTool } from './types'
import { t } from '../i18n'

const MAX_CHARS = 12_000
const FOCUS_CHUNKS = 3
const FOCUS_SIZE = 800
const CACHE_MAX = 16
const CACHE_TTL_MS = 15 * 60_000
const CACHE_MAX_CHARS = 2_000_000
const MAX_BYTES = 5 * 1024 * 1024

async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) return { text: '', truncated: false }
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { text: Buffer.concat(chunks).toString('utf8'), truncated: false }
    size += value.length
    if (size > MAX_BYTES) {
      chunks.push(value.subarray(0, value.length - (size - MAX_BYTES)))
      await reader.cancel()
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: true }
    }
    chunks.push(value)
  }
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** undici only says "fetch failed"; the useful part (DNS, TLS, reset) is in error.cause. */
function describeFetchError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  const code = cause?.code ?? ''
  const detail = cause?.message ?? (error as Error).message
  if ((error as Error).name === 'TimeoutError') return 'no response within 30 seconds'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${detail} — DNS could not find the host (typo, offline, or blocked by DNS/ISP)`
  if (/CERT|SELF_SIGNED|UNABLE_TO/.test(code)) {
    return `${detail} — TLS certificate rejected; often caused by an antivirus or proxy that inspects HTTPS. Try running with NODE_OPTIONS=--use-system-ca`
  }
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/.test(code)) {
    return `${detail} — connection failed (firewall, proxy, or the site is blocked by the network)`
  }
  return code ? `${detail} (${code})` : detail
}

const tokensOf = (text: string) => Math.ceil(text.length / 4)

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || /\.(local|internal|lan|localdomain|home\.arpa)$/.test(h)) return true
  if (h.includes(':')) return /^(::1?$|f[cd]|fe[89ab]|::ffff:)/.test(h)
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  return !h.includes('.')
}

const words = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []

export interface PinnedAddress {
  address: string
  family: number
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | PinnedAddress[], family?: number) => void

/**
 * A DNS lookup that answers with the address the rebinding guard already validated,
 * so the socket connects to exactly the IP that was checked (closes the
 * resolve-then-fetch gap). An empty pin falls back to the real resolver; a family
 * mismatch refuses instead of re-resolving, and unknown hostnames use real DNS.
 */
export function pinLookup(pinned: PinnedAddress[]): (hostname: string, options: unknown, callback: LookupCallback) => void {
  return (hostname, options, callback) => {
    const opts = (typeof options === 'object' && options !== null ? options : {}) as { all?: boolean; family?: number }
    const family = typeof options === 'number' ? options : opts.family
    const realDns = () => dnsCbLookup(hostname, (typeof options === 'number' ? { family: options } : opts) as never, callback as never)
    if (!pinned.length) return realDns()
    const list = family ? pinned.filter((a) => a.family === family) : pinned
    if (!list.length) {
      callback(Object.assign(new Error(`no pinned address for family ${family}`), { code: 'ENOTFOUND' }), '')
      return
    }
    if (opts.all) callback(null, list)
    else callback(null, list[0].address, list[0].family)
  }
}

/** Best BM25 chunks for `query`, in page order; null when no chunk shares a word with it. */
export function pickRelevant(text: string, query: string, count = FOCUS_CHUNKS, size = FOCUS_SIZE): string | null {
  const chunks: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    for (let i = 0; i < Math.max(line.length, 1); i += size) {
      cur += `${line.slice(i, i + size)}\n`
      if (cur.length >= size) {
        chunks.push(cur.trimEnd())
        cur = ''
      }
    }
  }
  if (cur.trim()) chunks.push(cur.trimEnd())
  const q = [...new Set(words(query))]
  const docs = chunks.map(words)
  const avg = docs.reduce((n, d) => n + d.length, 0) / (docs.length || 1) || 1
  const idf = q.map((t) => {
    const df = docs.filter((d) => d.includes(t)).length
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
  })
  const scored = docs
    .map((d, i) => ({
      i,
      score: q.reduce((sum, t, k) => {
        const tf = d.filter((w) => w === t).length
        return sum + (idf[k] * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.length) / avg))
      }, 0),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .sort((a, b) => a.i - b.i)
  return scored.length ? scored.map((c) => chunks[c.i]).join('\n…\n') : null
}

interface Page {
  text: string
  truncated: boolean
  at: number
}
const cache = new Map<string, Page | string>()
export const clearFetchCache = () => cache.clear()
function remember(key: string, value: Page | string, size: number) {
  if (size > CACHE_MAX_CHARS) return
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
}
function recall<T extends Page | string>(key: string): T | undefined {
  const hit = cache.get(key)
  if (typeof hit === 'object' && Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return hit as T | undefined
}

export interface FetchToolOptions {
  /** Keenable fetch endpoint used when `prompt` is given; null disables it. */
  keenableURL?: string | null
  isPrivate?: (host: string) => boolean
  /** DNS resolver for the rebinding guard; injectable for tests. */
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  /** Page fetch override for tests; receives the same init (including `dispatcher`). */
  fetchPage?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

const ACCEPT = 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5'
const withCost = (text: string, what: string) => `${what} · ${t('~{n} tokens', { n: tokensOf(text) })}`

export function createFetchTool(opts: FetchToolOptions = {}) {
  const keenableURL = opts.keenableURL === undefined ? 'https://api.keenable.ai/v1/fetch/public' : opts.keenableURL
  const isPrivate = opts.isPrivate ?? isPrivateHost
  const lookup = opts.lookup ?? ((hostname: string) => dnsLookup(hostname, { all: true }))
  return defineTool({
    name: 'fetch',
    description: `Fetch a URL (http/https) as text/markdown. Costs the user tokens, so ask for as little as you need:
- Pass \`prompt\` (what you want to know from the page) to get only the relevant excerpt instead of the whole page. Prefer this whenever you are looking for specific facts.
- Without \`prompt\` you get the first ${MAX_CHARS} characters; the reply tells you the \`offset\` to continue from.
- Fetching a page that is already in this conversation is wasteful; reuse what you have.`,
    schema: z.object({
      url: z.string().describe('Absolute http(s) URL'),
      prompt: z.string().max(2000).optional().describe('What to look for in the page; returns only the relevant excerpt'),
      offset: z.number().int().min(0).optional().describe('Start reading at this character (to continue a truncated page)'),
    }),
    kind: 'fetch',
    target: (input) => input.url,
    async run(input, ctx) {
      if (!/^https?:\/\//i.test(input.url)) return { output: 'URL must start with http:// or https://', isError: true }
      const target = new URL(input.url)
      // DNS rebinding guard: a public hostname may resolve to an internal address.
      // Literal IPs are never looked up (the user sees exactly what they typed), and a
      // DNS failure falls through so the fetch below reports the real error (ENOTFOUND).
      let pinned: PinnedAddress[] | undefined
      if (!isPrivate(target.hostname) && isIP(target.hostname) === 0) {
        try {
          const addresses = await lookup(target.hostname)
          const internal = addresses.find((a) => isPrivate(a.address))
          if (internal) {
            return {
              output: t('Blocked: {host} resolves to a private address ({addr}). Fetching an internal host through a public DNS name is not allowed.', { host: target.hostname, addr: internal.address }),
              isError: true,
            }
          }
          pinned = addresses
        } catch {
          // DNS error: let the fetch below surface it.
        }
      }
      const prompt = input.prompt?.trim()
      const askKeenable = !!prompt && !input.offset && !!keenableURL && !target.username && !target.password && !isPrivate(target.hostname)

      if (askKeenable) {
        const key = `x\n${input.url}\n${prompt}`
        const hit = recall<string>(key)
        if (hit) {
          ctx.refundFetch?.()
          return { output: hit, display: withCost(hit, t('focused excerpt · cache')) }
        }
        const out = await extractWithKeenable(keenableURL, input.url, prompt, ctx.signal)
        if (out) {
          const output = `[Excerpt from ${input.url} for "${prompt}" (extracted by Keenable). If it says the answer is not there, try fetch without a prompt.]\n${out}`
          remember(key, output, output.length)
          return { output, display: withCost(output, t('focused excerpt (Keenable)')) }
        }
      }

      let page = recall<Page>(`p\n${input.url}`)
      const cached = !!page
      if (cached) ctx.refundFetch?.()
      if (!page) {
        const loaded = await loadPage(input.url, ctx.signal, pinned, opts.fetchPage)
        if ('error' in loaded) return { output: loaded.error, isError: true }
        page = loaded
        remember(`p\n${input.url}`, page, page.text.length)
      }
      const { text, truncated } = page
      const via = cached ? ' · cache' : ''

      if (prompt && !input.offset) {
        const picked = pickRelevant(text, prompt)
        if (picked) {
          const output = `[Most relevant excerpt from ${input.url} for "${prompt}" (${text.length} characters total). Full page: fetch without a prompt.]\n${picked}`
          return { output, display: withCost(output, `${t('focused excerpt (local)')}${via}`) }
        }
      }

      const offset = input.offset ?? 0
      if (offset >= text.length && text.length > 0) {
        return { output: `offset ${offset} is past the end of the page (${text.length} characters).`, isError: true }
      }
      const end = Math.min(offset + MAX_CHARS, text.length)
      let output = text.slice(offset, end)
      if (end < text.length || truncated) {
        const total = truncated ? `${text.length}+` : text.length
        output += `\n… [truncated: characters ${offset}-${end} of ${total}. Continue with offset=${end}, or use prompt for a focused excerpt.]`
      }
      const size = truncated ? t('over 5 MB, truncated') : t('{n} characters', { n: text.length })
      return { output, display: withCost(output, `${size}${via}`) }
    },
  })
}

async function extractWithKeenable(endpoint: string, url: string, prompt: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const u = new URL(endpoint)
    u.searchParams.set('url', url)
    u.searchParams.set('prompt', prompt)
    u.searchParams.set('live', 'true')
    u.searchParams.set('max_chars', String(MAX_CHARS))
    const res = await fetch(u, { headers: { 'X-Keenable-Title': 'BotConnector' }, signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) })
    if (!res.ok) return undefined
    const content = ((await res.json()) as { content?: unknown }).content
    return typeof content === 'string' && content.trim() ? content.slice(0, MAX_CHARS) : undefined
  } catch {
    return undefined
  }
}

async function loadPage(
  inputUrl: string,
  signal: AbortSignal,
  pinned?: PinnedAddress[],
  fetchPage?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<{ text: string; truncated: boolean; at: number } | { error: string }> {
  // Follow redirects by hand: permission was granted for this host only.
  let url = new URL(inputUrl)
  // Pin the connection to the address the guard validated, so a second DNS answer
  // between check and fetch (rebinding) cannot move the socket. The pinned path uses
  // undici's own fetch: Node's built-in fetch embeds a different undici copy, and a
  // dispatcher built by the package only works when both sides are the same version.
  const dispatcher = pinned?.length ? new Agent({ connect: { lookup: pinLookup(pinned) } }) : undefined
  // Cast: undici's fetch Response type is structurally identical to the built-in one
  // but their Headers iterator types are nominally incompatible.
  const doFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> =
    fetchPage ?? (dispatcher ? (undiciFetch as unknown as typeof fetch) : fetch)
  try {
    let res: Response | undefined
    for (let hop = 0; hop < 5; hop++) {
      res = await doFetch(url, {
        headers: { accept: ACCEPT },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        redirect: 'manual',
        ...(dispatcher ? { dispatcher } : {}),
      })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!location) break
      const next = new URL(location, url)
      if (next.host !== url.host) {
        await res.body?.cancel()
        return { error: `Redirect to another host: ${next.href}. Call fetch again with that URL if needed (permission will be requested).` }
      }
      await res.body?.cancel()
      url = next
    }
    if (!res) return { error: `Failed to fetch ${inputUrl}` }
    const { text: body, truncated } = await readCapped(res)
    const type = res.headers.get('content-type') ?? ''
    const text = type.includes('html') ? htmlToText(body) : body
    if (!res.ok) return { error: `HTTP ${res.status} from ${inputUrl}: ${text.slice(0, 500)}` }
    return { text, truncated, at: Date.now() }
  } catch (error) {
    return { error: `Failed to fetch ${inputUrl}: ${describeFetchError(error)}` }
  } finally {
    await dispatcher?.close().catch(() => {})
  }
}

export const fetchTool = createFetchTool()
