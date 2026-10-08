import { createHash, randomBytes } from 'node:crypto'
import { t } from './i18n'

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
    // Guard race abort-sesudah-headers: sinyal sudah aborted SEBELUM body dibaca
    // (listener 'abort' tak akan fire lagi) → klasifikasi langsung dari asal signal.
    if (signal.aborted) {
      if (deps.signal?.aborted) return { ok: false, kind: 'cancelled', detail: '' }
      return { ok: false, kind: 'timeout', detail: '' }
    }
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

/** Balasan readLine saat Ctrl+C pada mode test; di produksi readLine exit 130 langsung. */
export const ABORT: unique symbol = Symbol('aborted')

/** Celah #1: hanya error ini = pembatalan (130); error lain = input gagal (1). */
function isReadCancel(error: unknown): boolean {
  const e = error as { name?: string; code?: string } | null
  return e?.name === 'AbortError' || e?.code === 'SIGINT'
}

export interface OauthLoginDeps {
  out(s: string): void
  err(s: string): void
  env: NodeJS.ProcessEnv
  isTTY: boolean
  open(url: string): void
  readLine(prompt: string): Promise<string | typeof ABORT>
  saveCredential(id: string, key: string): void
  fetch: typeof fetch
  timeoutMs?: number
}

export async function runOauthLogin(deps: OauthLoginDeps): Promise<number> {
  if (!deps.isTTY) {
    deps.err(t('bccli login openrouter needs a terminal. Use --key to paste an API key instead.'))
    return 1
  }
  const { verifier, challenge } = pkcePair()
  const url = buildAuthUrl(challenge)
  try {
    deps.open(url)
  } catch {
    deps.out(t('Could not open the browser automatically — open this URL manually: {url}', { url }))
  }
  let code: string | typeof ABORT
  try {
    code = await deps.readLine(t('Paste the authorization code from the browser: '))
  } catch (error) {
    // Celah #1: HANYA error klasifikasi-batal → 130; error stdin biasa → pesan aman + exit 1.
    if (isReadCancel(error)) return 130
    deps.err(
      t('Failed to read the authorization code: {reason}. Your stored credential was not changed.', {
        reason: String((error as Error)?.message ?? error).slice(0, 200),
      }),
    )
    return 1
  }
  if (code === ABORT) return 130
  if (typeof code !== 'string' || code.trim() === '') {
    deps.err(t('Authorization code is empty. Run bccli login openrouter again.'))
    return 1
  }
  const trimmed = code.trim()
  const secrets = [trimmed, verifier]
  // Rev #3: SIGINT HANYA selama exchange; cleanup listener di finally (baseline pulih di semua jalur).
  const result = await (async () => {
    const controller = new AbortController()
    const onSigint = (): void => controller.abort()
    process.once('SIGINT', onSigint)
    try {
      return await exchangeAuthCode(trimmed, verifier, {
        fetch: deps.fetch,
        timeoutMs: deps.timeoutMs,
        signal: controller.signal,
      })
    } finally {
      process.removeListener('SIGINT', onSigint)
    }
  })()
  if (!result.ok) {
    const detail = redact(result.detail, secrets)
    switch (result.kind) {
      case 'cancelled':
        deps.err(t('Login cancelled.'))
        return 130
      case 'timeout':
        deps.err(
          t('The exchange with OpenRouter timed out after {seconds}s. Your stored credential was not changed.', {
            seconds: String(Math.round((deps.timeoutMs ?? EXCHANGE_TIMEOUT_MS) / 1000)),
          }),
        )
        return 1
      case 'network':
        deps.err(t('Could not reach OpenRouter: {reason}. Your stored credential was not changed.', { reason: detail }))
        return 1
      case 'http403-expired':
        deps.err(t('Authorization code expired — codes are valid for 10 minutes. Run bccli login openrouter again.'))
        return 1
      case 'http403-rejected':
        deps.err(t('OpenRouter rejected the authorization code (403): {detail}. Run bccli login openrouter again.', { detail: detail || 'no details' }))
        return 1
      case 'invalid-body':
        deps.err(t('OpenRouter did not return an API key in the expected format. Your stored credential was not changed.'))
        return 1
      case 'http-other':
        deps.err(t('OpenRouter exchange failed ({status}): {detail}. Your stored credential was not changed.', { status: String(result.status ?? 0), detail }))
        return 1
    }
  }
  try {
    deps.saveCredential('openrouter', result.key)
  } catch (error) {
    // Kontrak #4: remote ADA, lokal TIDAK, pemulihan via dashboard — tanpa mencetak key.
    deps.err(
      t('The key was created on your OpenRouter account but could not be saved locally ({reason}). Manage it (copy or revoke) at {dashboard}, then run bccli login openrouter again.', {
        reason: redact(String((error as Error)?.message ?? ''), [result.key, trimmed, verifier]).slice(0, 200),
        dashboard: OPENROUTER_DASHBOARD_URL,
      }),
    )
    return 1
  }
  deps.out(t('Logged in: openrouter credential saved.'))
  if (deps.env[OPENROUTER_ENV_KEY]) {
    deps.out(t('Note: {env} is set in the environment and takes priority over the stored credential.', { env: OPENROUTER_ENV_KEY }))
  }
  deps.out(t('Verify with: bccli models openrouter (your key is never printed).'))
  return 0
}

export interface OauthLogoutDeps {
  out(s: string): void
  err(s: string): void
  env: NodeJS.ProcessEnv
  removeCredential(id: string): boolean
}

export async function runOauthLogout(deps: OauthLogoutDeps): Promise<number> {
  const removed = deps.removeCredential('openrouter')
  if (removed) deps.out(t('openrouter credential removed.'))
  else deps.out(t('openrouter credential was not stored.'))
  if (deps.env[OPENROUTER_ENV_KEY]) {
    // Rev #4: tampil WALAU credential lokal tidak ada (removed maupun not-stored).
    deps.out(t('Note: {env} is still set in the environment and will keep being used.', { env: OPENROUTER_ENV_KEY }))
  }
  deps.out(t('To revoke keys on your account, open {dashboard}.', { dashboard: OPENROUTER_DASHBOARD_URL }))
  return 0
}
