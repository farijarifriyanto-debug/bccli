import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { setLanguage } from '../src/i18n'
import {
  buildAuthUrl,
  classifyExchange403,
  exchangeAuthCode,
  OPENROUTER_AUTH_URL,
  OPENROUTER_EXCHANGE_URL,
  pkcePair,
  redact,
} from '../src/oauthLogin'

beforeAll(() => setLanguage('en'))
afterAll(() => setLanguage('id'))

const b64url = (b: Buffer): string => b.toString('base64url')

test('pkcePair: challenge = BASE64URL(SHA256(verifier)); charset url-safe; verifier unik', () => {
  const a = pkcePair()
  expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 byte → base64url tanpa padding
  expect(a.challenge).toBe(b64url(createHash('sha256').update(a.verifier, 'ascii').digest()))
  expect(pkcePair().verifier).not.toBe(a.verifier)
})

test('buildAuthUrl: persis 3 param terdokumentasi; TANPA state/callback_url; encoding benar', () => {
  const { challenge } = pkcePair()
  const url = new URL(buildAuthUrl(challenge))
  expect(url.origin + url.pathname).toBe(OPENROUTER_AUTH_URL)
  expect([...url.searchParams.keys()].sort()).toEqual(['code_challenge', 'code_challenge_method', 'key_label'])
  expect(url.searchParams.get('code_challenge')).toBe(challenge)
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('key_label')).toBe('bccli')
})

test('redact: mengganti semua secret (multi, berulang) dengan ***', () => {
  expect(redact('key=abc123 and again abc123', ['abc123'])).toBe('key=*** and again ***')
  expect(redact('clean text', ['abc'])).toBe('clean text')
  expect(redact('a', [])).toBe('a')
})

test('classifyExchange403: hanya yang memuat expired → expired; lainnya rejected', () => {
  expect(classifyExchange403('Authorization code expired: restart the OAuth flow')).toBe('expired')
  expect(classifyExchange403('invalid code')).toBe('rejected')
  expect(classifyExchange403('EXPIRED')).toBe('expired') // case-insensitive
  expect(classifyExchange403('')).toBe('rejected') // body kosong ≠ expired
  expect(classifyExchange403('code and verifier mismatch')).toBe('rejected')
})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('exchange sukses: POST exchange URL, body persis {code, code_verifier, S256}, hasil key', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return jsonResponse(200, { key: 'sk-or-v1-TESTKEY' })
  }) as typeof fetch
  const r = await exchangeAuthCode('CODE123', 'VERIF', { fetch: f })
  expect(r).toEqual({ ok: true, key: 'sk-or-v1-TESTKEY' })
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe(OPENROUTER_EXCHANGE_URL)
  const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
  expect(body).toEqual({ code: 'CODE123', code_verifier: 'VERIF', code_challenge_method: 'S256' })
  const headers = calls[0].init?.headers as Record<string, string> | undefined
  expect(headers?.['Content-Type']).toBe('application/json')
})

test('exchange 403 expired vs 403 invalid vs 403 kosong → kind berbeda (bukan semua expired)', async () => {
  const mk = (status: number, body: unknown) => (async () => jsonResponse(status, body)) as typeof fetch
  expect(await exchangeAuthCode('c', 'v', { fetch: mk(403, { error: 'Authorization code expired: xxx' }) })).toMatchObject({
    ok: false,
    kind: 'http403-expired',
    status: 403,
  })
  expect(await exchangeAuthCode('c', 'v', { fetch: mk(403, { error: 'invalid code or verifier' }) })).toMatchObject({
    ok: false,
    kind: 'http403-rejected',
  })
  expect(await exchangeAuthCode('c', 'v', { fetch: mk(403, {}) })).toMatchObject({ ok: false, kind: 'http403-rejected' })
  expect(await exchangeAuthCode('c', 'v', { fetch: mk(400, { error: 'bad request' }) })).toMatchObject({
    ok: false,
    kind: 'http-other',
    status: 400,
  })
})

test('exchange: status/payload ketat — null, whitespace, JSON invalid, 201, 204 (semua ditolak)', async () => {
  const raw = (status: number, text: string) => (async () => new Response(text, { status })) as typeof fetch
  const json = (status: number, body: unknown) => (async () => jsonResponse(status, body)) as typeof fetch
  expect(await exchangeAuthCode('c', 'v', { fetch: json(200, null) })).toMatchObject({ ok: false, kind: 'invalid-body' })
  expect(await exchangeAuthCode('c', 'v', { fetch: json(200, { key: '   ' }) })).toMatchObject({ ok: false, kind: 'invalid-body' })
  expect(await exchangeAuthCode('c', 'v', { fetch: json(200, ['key']) })).toMatchObject({ ok: false, kind: 'invalid-body' })
  expect(await exchangeAuthCode('c', 'v', { fetch: raw(200, 'not-json{{{') })).toMatchObject({ ok: false, kind: 'invalid-body' })
  // 201 dengan body key VALID tetap ditolak — status diperiksa SEBELUM payload
  expect(await exchangeAuthCode('c', 'v', { fetch: json(201, { key: 'valid-key' }) })).toMatchObject({
    ok: false,
    kind: 'http-other',
    status: 201,
  })
  // 204 = null-body status: Response constructor MENOLAK body → buat dgn null body
  expect(await exchangeAuthCode('c', 'v', { fetch: (async () => new Response(null, { status: 204 })) as typeof fetch })).toMatchObject({
    ok: false,
    kind: 'http-other',
    status: 204,
  })
  const other = await exchangeAuthCode('c', 'v', { fetch: json(500, { error: 'boom', nested: { x: 1 } }) })
  expect(other).toMatchObject({ ok: false, kind: 'http-other', status: 500, detail: 'boom' }) // whitelist error/message saja
})

test('exchange: caller signal → kind cancelled (rev #3)', async () => {
  const ctrl = new AbortController()
  const hang = (async () =>
    new Promise<Response>((_resolve, reject) => {
      ctrl.signal.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    })) as typeof fetch
  const p = exchangeAuthCode('c', 'v', { fetch: hang, signal: ctrl.signal })
  ctrl.abort()
  expect(await p).toMatchObject({ ok: false, kind: 'cancelled' })
  // pembanding timeout sudah tercakup test timeout terpisah (kind 'timeout', bukan 'cancelled')
})

test('exchange: timeout → kind timeout (fetch memakai signal timeoutMs kecil)', async () => {
  const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const e = new Error('The operation was aborted due to timeout')
        e.name = 'TimeoutError'
        reject(e)
      })
    })
  }) as typeof fetch
  const r = await exchangeAuthCode('c', 'v', { fetch: f, timeoutMs: 5 })
  expect(r).toMatchObject({ ok: false, kind: 'timeout' })
})

test('exchange: fetch throw (jaringan) → kind network; detail = pesan error (siap di-redact)', async () => {
  const f = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  // Secret realistis (bukan 1-karakter) agar redact tidak over-match pada teks error biasa
  expect(await exchangeAuthCode('CODE-NET-1', 'VERIF-NET-123', { fetch: f })).toMatchObject({
    ok: false,
    kind: 'network',
    detail: 'fetch failed',
  })
})

test('exchange: detail = REDACT LALU truncate — verifier aktual dari body stub, melintasi batas 200 (rev #1)', async () => {
  let captured = ''
  const boundaryFetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    captured = (JSON.parse(String(init?.body)) as { code_verifier: string }).code_verifier
    return jsonResponse(500, { error: 'x'.repeat(196) + captured })
  }) as typeof fetch
  const r = await exchangeAuthCode('CODE-X', 'VERIF-ACTUAL-123456', { fetch: boundaryFetch })
  expect(captured).toBe('VERIF-ACTUAL-123456') // diambil dari request stub, bukan literal semata
  expect(r.ok).toBe(false)
  const detail = r.ok === false ? r.detail : ''
  expect(detail).toContain('***')
  expect(detail).not.toContain('VERIF-ACTUAL-123456')
  expect(detail).not.toContain('VERIF-ACT') // 8-char prefix: tak ada potongan parsial secret
  expect(detail.length).toBeLessThanOrEqual(200)
})
