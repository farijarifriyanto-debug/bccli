import { createHmac, timingSafeEqual } from 'node:crypto'

/** Header wajib GitHub webhook delivery. */
export const GITHUB_HEADERS = ['x-hub-signature-256', 'x-hub-delivery', 'x-hub-event'] as const

export interface CommentDelivery {
  delivery: string
  event: string
  action: string
  repo: string
  number: number
  isPR: boolean
  author: string
  authorType: string
  body: string
}

export type VerifyOutcome =
  | { ok: true; delivery: CommentDelivery }
  | { ok: false; status: 400 | 401 | 405 | 413 | 415 | 503; message: string }

/** 'sha256=<hex>' atas byte mentah — dipakai verifikasi dan fixture test. */
export function signBody(rawBody: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}

const HARD_TIMEOUT_MARKER = '<child did not close after termination>'
export { HARD_TIMEOUT_MARKER }

/**
 * Urutan persis spec §3: method → content-type → size (byte) → header wajib →
 * secret (aksesor per-request) → HMAC atas Buffer MENTAH → decode UTF-8 fatal →
 * parse → tipe-guard field event. HMAC selalu sebelum decode/parse.
 */
export function verifyAndParse(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  opts: {
    method: string
    contentType: string | undefined
    maxBodyBytes: number
    getSecret: () => string | undefined
  },
  jsonParse: (text: string) => unknown = JSON.parse,
): VerifyOutcome {
  if (opts.method !== 'POST') return { ok: false, status: 405, message: 'method not allowed' }
  if (opts.contentType !== undefined && !opts.contentType.toLowerCase().includes('application/json')) {
    return { ok: false, status: 415, message: 'content-type must be application/json' }
  }
  if (rawBody.length > opts.maxBodyBytes) return { ok: false, status: 413, message: 'body too large' }
  for (const name of GITHUB_HEADERS) {
    if (!headers[name]) return { ok: false, status: 400, message: `missing header ${name}` }
  }
  const secret = opts.getSecret()
  if (!secret) return { ok: false, status: 503, message: 'webhook secret unavailable' }
  const provided = headers['x-hub-signature-256'] ?? ''
  const expected = signBody(rawBody, secret)
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, status: 401, message: 'signature mismatch' }
  // HMAC lolos → decode UTF-8 FATAL dulu, baru parse (rev #6: byte sebelum decode).
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody)
  } catch {
    return { ok: false, status: 400, message: 'body is not valid UTF-8' }
  }
  let parsed: unknown
  try {
    parsed = jsonParse(text)
  } catch {
    return { ok: false, status: 400, message: 'body is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, message: 'body must be a JSON object' }
  }
  const rec = parsed as Record<string, unknown>
  const issue = rec.issue as Record<string, unknown> | undefined
  const comment = rec.comment as Record<string, unknown> | undefined
  const repository = rec.repository as Record<string, unknown> | undefined
  const user = (comment?.user ?? undefined) as Record<string, unknown> | undefined
  const action = rec.action
  const number = issue?.number
  const login = user?.login
  const authorType = user?.type
  const commentBody = comment?.body
  const fullName = repository?.full_name
  if (
    typeof action !== 'string' ||
    typeof number !== 'number' ||
    typeof login !== 'string' ||
    typeof authorType !== 'string' ||
    typeof commentBody !== 'string' ||
    typeof fullName !== 'string'
  ) {
    return { ok: false, status: 400, message: 'missing event fields' }
  }
  return {
    ok: true,
    delivery: {
      delivery: headers['x-hub-delivery'] as string,
      event: headers['x-hub-event'] as string,
      action,
      repo: fullName,
      number,
      isPR: 'pull_request' in rec,
      author: login,
      authorType,
      body: commentBody,
    },
  }
}

/**
 * '/bccli <task>' → task trim; '/bccli' tanpa task → null (tanpa balasan);
 * prefix lain / komentar biasa → null.
 */
export function extractCommand(body: string): string | null {
  const trimmed = body.trimStart()
  if (!trimmed.startsWith('/bccli')) return null
  const rest = trimmed.slice('/bccli'.length)
  if (rest.length > 0 && !/^\s/.test(rest)) return null // '/bcclix' is not a command
  const task = rest.trim()
  return task === '' ? null : task
}

/** Potong di batas code point dengan budget byte UTF-8 — tak pernah membelah karakter. */
export function truncateUtf8Bytes(text: string, maxBytes: number, marker = '…[truncated]…'): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  let out = ''
  let used = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > budget) break
    out += ch
    used += size
  }
  return out + marker
}

/** 60% kepala + 40% ekor dalam SATU budget byte, dengan marker di tengah. */
export function truncateHeadTailUtf8(text: string, maxBytes: number, marker = '…[truncated]…'): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const markerBytes = Buffer.byteLength(marker, 'utf8')
  const budget = Math.max(0, maxBytes - markerBytes)
  const headBudget = Math.floor(budget * 0.6)
  const tailBudget = budget - headBudget
  const chars = [...text]
  let head = ''
  let used = 0
  for (const ch of chars) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > headBudget) break
    head += ch
    used += size
  }
  let tail = ''
  let tailUsed = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]
    const size = Buffer.byteLength(ch, 'utf8')
    if (tailUsed + size > tailBudget) break
    tail = ch + tail
    tailUsed += size
  }
  return head + marker + tail
}
