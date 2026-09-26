import { z } from 'zod'
import { defineTool } from './types'

const MAX_CHARS = 50_000
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

export const fetchTool = defineTool({
  name: 'fetch',
  description: 'Fetch a URL (http/https). HTML is converted to plain text. Max 50k characters.',
  schema: z.object({ url: z.string().describe('Absolute http(s) URL') }),
  kind: 'fetch',
  target: (input) => input.url,
  async run(input, ctx) {
    if (!/^https?:\/\//i.test(input.url)) return { output: 'URL harus diawali http:// atau https://', isError: true }
    // Follow redirects by hand: permission was granted for this host only.
    let url = new URL(input.url)
    let res: Response | undefined
    try {
      for (let hop = 0; hop < 5; hop++) {
        res = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]), redirect: 'manual' })
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
        if (!location) break
        const next = new URL(location, url)
        if (next.host !== url.host) {
          await res.body?.cancel()
          return {
            output: `Redirect ke host lain: ${next.href}. Panggil fetch lagi dengan URL itu kalau memang perlu (akan diminta izin).`,
            isError: true,
          }
        }
        await res.body?.cancel()
        url = next
      }
    } catch (error) {
      return { output: `Gagal mengambil ${input.url}: ${(error as Error).message}`, isError: true }
    }
    if (!res) return { output: `Gagal mengambil ${input.url}`, isError: true }
    const { text: body, truncated } = await readCapped(res)
    if (!res.ok) return { output: `HTTP ${res.status} dari ${input.url}: ${body.slice(0, 500)}`, isError: true }
    const text = (res.headers.get('content-type') ?? '').includes('html') ? htmlToText(body) : body
    const clipped = text.length > MAX_CHARS || truncated ? `${text.slice(0, MAX_CHARS)}\n… [dipotong]` : text
    const display = truncated ? 'lebih dari 5 MB, dipotong' : `${text.length} karakter`
    return { output: clipped, display }
  },
})
