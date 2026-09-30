import { z } from 'zod'
import { defineTool } from './types'

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
  if ((error as Error).name === 'TimeoutError') return 'tidak ada jawaban dalam 30 detik'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${detail} — DNS tidak menemukan host (salah ketik, offline, atau diblokir DNS/ISP)`
  if (/CERT|SELF_SIGNED|UNABLE_TO/.test(code)) {
    return `${detail} — sertifikat TLS ditolak; sering karena antivirus/proxy yang memeriksa HTTPS. Coba jalankan dengan NODE_OPTIONS=--use-system-ca`
  }
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/.test(code)) {
    return `${detail} — koneksi gagal (firewall, proxy, atau situs diblokir jaringan)`
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
}

const ACCEPT = 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5'
const withCost = (text: string, what: string) => `${what} · ~${tokensOf(text)} token`

export function createFetchTool(opts: FetchToolOptions = {}) {
  const keenableURL = opts.keenableURL === undefined ? 'https://api.keenable.ai/v1/fetch/public' : opts.keenableURL
  const isPrivate = opts.isPrivate ?? isPrivateHost
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
      if (!/^https?:\/\//i.test(input.url)) return { output: 'URL harus diawali http:// atau https://', isError: true }
      const target = new URL(input.url)
      const prompt = input.prompt?.trim()
      const askKeenable = !!prompt && !input.offset && !!keenableURL && !target.username && !target.password && !isPrivate(target.hostname)

      if (askKeenable) {
        const key = `x\n${input.url}\n${prompt}`
        const hit = recall<string>(key)
        if (hit) return { output: hit, display: withCost(hit, 'kutipan fokus · cache') }
        const out = await extractWithKeenable(keenableURL, input.url, prompt, ctx.signal)
        if (out) {
          const output = `[Kutipan dari ${input.url} untuk "${prompt}" (diekstrak Keenable). Kalau jawabannya "tidak ada", coba fetch tanpa prompt.]\n${out}`
          remember(key, output, output.length)
          return { output, display: withCost(output, 'kutipan fokus (Keenable)') }
        }
      }

      let page = recall<Page>(`p\n${input.url}`)
      const cached = !!page
      if (!page) {
        const loaded = await loadPage(input.url, ctx.signal)
        if ('error' in loaded) return { output: loaded.error, isError: true }
        page = loaded
        remember(`p\n${input.url}`, page, page.text.length)
      }
      const { text, truncated } = page
      const via = cached ? ' · cache' : ''

      if (prompt && !input.offset) {
        const picked = pickRelevant(text, prompt)
        if (picked) {
          const output = `[Kutipan paling relevan dari ${input.url} untuk "${prompt}" (${text.length} karakter total). Halaman penuh: fetch tanpa prompt.]\n${picked}`
          return { output, display: withCost(output, `kutipan fokus (lokal)${via}`) }
        }
      }

      const offset = input.offset ?? 0
      if (offset >= text.length && text.length > 0) {
        return { output: `offset ${offset} melewati akhir halaman (${text.length} karakter).`, isError: true }
      }
      const end = Math.min(offset + MAX_CHARS, text.length)
      let output = text.slice(offset, end)
      if (end < text.length || truncated) {
        const total = truncated ? `${text.length}+` : text.length
        output += `\n… [dipotong: karakter ${offset}-${end} dari ${total}. Lanjut dengan offset=${end}, atau pakai prompt untuk kutipan terfokus.]`
      }
      const size = truncated ? 'lebih dari 5 MB, dipotong' : `${text.length} karakter`
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

async function loadPage(inputUrl: string, signal: AbortSignal): Promise<{ text: string; truncated: boolean; at: number } | { error: string }> {
  // Follow redirects by hand: permission was granted for this host only.
  let url = new URL(inputUrl)
  let res: Response | undefined
  try {
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(url, { headers: { accept: ACCEPT }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), redirect: 'manual' })
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
      if (!location) break
      const next = new URL(location, url)
      if (next.host !== url.host) {
        await res.body?.cancel()
        return { error: `Redirect ke host lain: ${next.href}. Panggil fetch lagi dengan URL itu kalau memang perlu (akan diminta izin).` }
      }
      await res.body?.cancel()
      url = next
    }
  } catch (error) {
    return { error: `Gagal mengambil ${inputUrl}: ${describeFetchError(error)}` }
  }
  if (!res) return { error: `Gagal mengambil ${inputUrl}` }
  const { text: body, truncated } = await readCapped(res)
  const type = res.headers.get('content-type') ?? ''
  const text = type.includes('html') ? htmlToText(body) : body
  if (!res.ok) return { error: `HTTP ${res.status} dari ${inputUrl}: ${text.slice(0, 500)}` }
  return { text, truncated, at: Date.now() }
}

export const fetchTool = createFetchTool()
