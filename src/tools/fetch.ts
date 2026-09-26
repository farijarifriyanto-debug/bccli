import { z } from 'zod'
import { defineTool } from './types'

const MAX_CHARS = 50_000

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

export const fetchTool = defineTool({
  name: 'fetch',
  description: 'Fetch a URL (http/https). HTML is converted to plain text. Max 50k characters.',
  schema: z.object({ url: z.string().describe('Absolute http(s) URL') }),
  kind: 'fetch',
  target: (input) => input.url,
  async run(input, ctx) {
    if (!/^https?:\/\//i.test(input.url)) return { output: 'URL harus diawali http:// atau https://', isError: true }
    let res: Response
    try {
      res = await fetch(input.url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]), redirect: 'follow' })
    } catch (error) {
      return { output: `Gagal mengambil ${input.url}: ${(error as Error).message}`, isError: true }
    }
    const body = await res.text()
    if (!res.ok) return { output: `HTTP ${res.status} dari ${input.url}: ${body.slice(0, 500)}`, isError: true }
    const text = (res.headers.get('content-type') ?? '').includes('html') ? htmlToText(body) : body
    const clipped = text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… [dipotong]` : text
    return { output: clipped, display: `${text.length} karakter` }
  },
})
