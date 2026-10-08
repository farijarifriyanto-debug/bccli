import { createHash, randomBytes } from 'node:crypto'

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth'
export const OPENROUTER_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys'
export const OPENROUTER_DASHBOARD_URL = 'https://openrouter.ai/settings/keys'
export const OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY'
const KEY_LABEL = 'bccli'
const EXCHANGE_TIMEOUT_MS = 15_000
const DETAIL_MAX = 200

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return { verifier, challenge }
}

/** Varian tanpa redirect per docs resmi OpenRouter: kode ditampilkan untuk di-copy. */
export function buildAuthUrl(challenge: string): string {
  const url = new URL(OPENROUTER_AUTH_URL)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('key_label', KEY_LABEL)
  return url.href
}

export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const s of secrets) {
    if (!s) continue
    out = out.split(s).join('***')
  }
  return out
}

export function classifyExchange403(detail: string): 'expired' | 'rejected' {
  return detail.toLowerCase().includes('expired') ? 'expired' : 'rejected'
}

function extractWhitelistDetail(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const rec = body as Record<string, unknown>
  return typeof rec.error === 'string' ? rec.error : typeof rec.message === 'string' ? rec.message : ''
}

/**
 * Pipeline wajib: extract whitelist -> redact(secrets) -> truncate 200.
 * Truncate sebelum redact memotong secret di tengah -> redact gagal cocok -> bocor parsial.
 */
function safeDetail(raw: string, secrets: string[]): string {
  return redact(raw, secrets).slice(0, DETAIL_MAX)
}

export type ExchangeResult =
  | { ok: true; key: string }
  | {
      ok: false
      kind: 'timeout' | 'network' | 'cancelled' | 'http403-expired' | 'http403-rejected' | 'http-other' | 'invalid-body'
      status?: number
      detail: string
    }

export async function exchangeAuthCode(
  code: string,
  verifier: string,
  deps: { fetch: typeof fetch; timeoutMs?: number; signal?: AbortSignal },
): Promise<ExchangeResult> {
  const secrets = [code, verifier]
  const timeoutSignal = AbortSignal.timeout(deps.timeoutMs ?? EXCHANGE_TIMEOUT_MS)
  const signal = deps.signal ? AbortSignal.any([timeoutSignal, deps.signal]) : timeoutSignal
  // Celah #2: fetch DAN res.json() dalam SATU try — abort saat baca body ikut terklasifikasi.
  let parsed: unknown
  let status = 0
  try {
    const res = await deps.fetch(OPENROUTER_EXCHANGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal,
    })
    status = res.status
    try {
      parsed = await res.json()
    } catch (error) {
      if (deps.signal?.aborted || timeoutSignal.aborted) throw error // abort saat body -> klasifikasi di catch luar
      parsed = undefined // body rusak TANPA abort -> invalid-body pada status 200
    }
  } catch (error) {
    // Asal signal = sumber kebenaran (bukan nama exception): caller dulu, lalu timeout.
    if (deps.signal?.aborted) return { ok: false, kind: 'cancelled', detail: '' }
    if (timeoutSignal.aborted) return { ok: false, kind: 'timeout', detail: '' }
    return { ok: false, kind: 'network', detail: safeDetail(String((error as Error)?.message ?? ''), secrets) }
  }
  const detail = safeDetail(extractWhitelistDetail(parsed), secrets)
  // Rev #2: HANYA 200 diterima — status diperiksa SEBELUM payload (201/204 ditolak walau body valid).
  if (status !== 200) {
    if (status === 403) {
      return classifyExchange403(detail) === 'expired'
        ? { ok: false, kind: 'http403-expired', status: 403, detail }
        : { ok: false, kind: 'http403-rejected', status: 403, detail }
    }
    return { ok: false, kind: 'http-other', status, detail }
  }
  // Payload wajib object non-null (bukan array/scalar) + key string non-blank.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, kind: 'invalid-body', detail: '' }
  }
  const key = (parsed as { key?: unknown }).key
  if (typeof key !== 'string' || key.trim() === '') return { ok: false, kind: 'invalid-body', detail: '' }
  return { ok: true, key }
}
