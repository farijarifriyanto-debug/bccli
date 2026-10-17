# `bccli login openrouter` (OAuth PKCE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** login provider OpenRouter via OAuth PKCE resmi (browser + paste kode terminal) yang menghasilkan API key tersimpan di credential yang ada, plus `--key` (jalur lama) dan `--logout`, dengan 6 kontrak kegagalan/akurasi user.

**Architecture:** `src/oauthLogin.ts` murni+orkestrasi dengan deps injection penuh (`fetch/open/readLine/saveCredential/removeCredential`) → memetakan seluruh matriks pesan §6 spec tanpa jaringan nyata; `readLine` terlihat baru di `login.ts`; dispatch `login` di `login.ts` dengan guard konflik PERTAMA; wiring `args.ts` (`--key`/`--logout`) + HELP/i18n.

**Tech Stack:** Node ≥22, TypeScript strict, `node:crypto` (PKCE), `fetch` global (injectable), vitest 5, **tanpa dependency baru**.

**Spec:** `docs/superpowers/specs/2026-10-08-oauth-openrouter-login-design.md`

## Global Constraints

- **DOKUMEN INI BELUM di-commit** (larangan user saat menulis): commit docs hanya SETELAH review plan lolos; setelah itu eksekusi TDD per task dengan commit lokal per task.
- **TANPA login OAuth nyata, TANPA menyentuh credential aktif user** (semua test pakai `BCCLI_HOME` tmp + deps palsu), tanpa push/publish/deploy.
- Key/kode/verifier/body respons mentah **tidak pernah** dicetak output test pun (assert negatif).
- Semua string `t()` + key di `src/i18n/id.ts` (HELP = key byte-identik EN); test i18n menjaga.
- Suite bahasa Indonesia; test yang meng-assert teks `t()` EN WAJIB pin `setLanguage('en')` + `afterAll` restore `'id'` (pola pluginsCli).
- Gate per task: `npx tsc --noEmit`, `npm run lint` 0/0, `npm test` hijau.
- Edit file hanya via tool edit/write.

---

### Task 1: `src/oauthLogin.ts` — PKCE, URL, redact, exchange (murni)

**Files:**
- Create: `src/oauthLogin.ts`
- Test: `test/oauthLogin.test.ts`

**Interfaces:**
- Consumes: tidak ada (murni; fetch di-inject).
- Produks (dipakai Task 2–3):
  - `export function pkcePair(): { verifier: string; challenge: string }`
  - `export function buildAuthUrl(challenge: string): string`
  - `export function redact(text: string, secrets: string[]): string`
  - `export function classifyExchange403(detail: string): 'expired' | 'rejected'`
  - `export type ExchangeResult = { ok: true; key: string } | { ok: false; kind: 'timeout' | 'network' | 'cancelled' | 'http403-expired' | 'http403-rejected' | 'http-other' | 'invalid-body'; status?: number; detail: string }`
  - `export async function exchangeAuthCode(code: string, verifier: string, deps: { fetch: typeof fetch; timeoutMs?: number; signal?: AbortSignal }): Promise<ExchangeResult>` —
    `signal` = AbortController pemanggil (SIGINT saat exchange → `cancelled`); detail = redact LALU truncate
  - `export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth'` / `OPENROUTER_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys'` / `OPENROUTER_DASHBOARD_URL = 'https://openrouter.ai/settings/keys'` / `OPENROUTER_ENV_KEY = 'OPENROUTER_API_KEY'`

- [ ] **Step 1: Test gagal** — `test/oauthLogin.test.ts`:

```ts
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { setLanguage } from '../src/i18n'
import {
  buildAuthUrl, classifyExchange403, exchangeAuthCode, OPENROUTER_AUTH_URL,
  OPENROUTER_EXCHANGE_URL, pkcePair, redact,
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
  expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
})

test('exchange 403 expired vs 403 invalid vs 403 kosong → kind berbeda (bukan semua expired)', async () => {
  const mk = (status: number, body: unknown) => (async () => jsonResponse(status, body)) as typeof fetch
  expect(await exchangeAuthCode('c', 'v', { fetch: mk(403, { error: 'Authorization code expired: xxx' }) }))
    .toMatchObject({ ok: false, kind: 'http403-expired', status: 403 })
  expect(await exchangeAuthCode('c', 'v', { fetch: mk(403, { error: 'invalid code or verifier' }) }))
    .toMatchObject({ ok: false, kind: 'http403-rejected' })
  expect(await exchangeAuthCode('c', 'v', { fetch: mk(403, {}) })).toMatchObject({ ok: false, kind: 'http403-rejected' })
  expect(await exchangeAuthCode('c', 'v', { fetch: mk(400, { error: 'bad request' }) }))
    .toMatchObject({ ok: false, kind: 'http-other', status: 400 })
})

test('exchange: status/payload ketat — null, whitespace, JSON invalid, 201, 204 (semua ditolak)', async () => {
  const raw = (status: number, text: string) => (async () => new Response(text, { status })) as typeof fetch
  const json = (status: number, body: unknown) => (async () => jsonResponse(status, body)) as typeof fetch
  expect(await exchangeAuthCode('c', 'v', { fetch: json(200, null) })).toMatchObject({ ok: false, kind: 'invalid-body' })
  expect(await exchangeAuthCode('c', 'v', { fetch: json(200, { key: '   ' }) })).toMatchObject({ ok: false, kind: 'invalid-body' })
  expect(await exchangeAuthCode('c', 'v', { fetch: json(200, ['key']) })).toMatchObject({ ok: false, kind: 'invalid-body' }) // array ≠ object payload
  expect(await exchangeAuthCode('c', 'v', { fetch: raw(200, 'not-json{{{') })).toMatchObject({ ok: false, kind: 'invalid-body' })
  // 201 dengan body key VALID tetap ditolak — status diperiksa SEBELUM payload
  expect(await exchangeAuthCode('c', 'v', { fetch: json(201, { key: 'valid-key' }) })).toMatchObject({ ok: false, kind: 'http-other', status: 201 })
  expect(await exchangeAuthCode('c', 'v', { fetch: raw(204, '') })).toMatchObject({ ok: false, kind: 'http-other', status: 204 })
  const other = await exchangeAuthCode('c', 'v', { fetch: json(500, { error: 'boom', nested: { x: 1 } }) })
  expect(other).toMatchObject({ ok: false, kind: 'http-other', status: 500, detail: 'boom' }) // whitelist error/message saja
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
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'TimeoutError'
      init?.signal?.addEventListener('abort', () => reject(err))
    })
  }) as typeof fetch
  const r = await exchangeAuthCode('c', 'v', { fetch: f, timeoutMs: 5 })
  expect(r).toMatchObject({ ok: false, kind: 'timeout' })
})

test('exchange: fetch throw (jaringan) → kind network; detail = pesan error (siap di-redact)', async () => {
  const f = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  expect(await exchangeAuthCode('c', 'v', { fetch: f })).toMatchObject({ ok: false, kind: 'network', detail: 'fetch failed' })
})
```

- [ ] **Step 2: RED** — `npx vitest run test/oauthLogin.test.ts`.

- [ ] **Step 3: Implementasi** — `src/oauthLogin.ts`:

```ts
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
 * Pipeline wajib (rev #1): extract whitelist → redact(secrets) → truncate 200.
 * Truncate sebelum redact memotong secret di tengah → redact gagal cocok → bocor parsial.
 */
function safeDetail(raw: string, secrets: string[]): string {
  return redact(raw, secrets).slice(0, DETAIL_MAX)
}

export type ExchangeResult =
  | { ok: true; key: string }
  | { ok: false; kind: 'timeout' | 'network' | 'cancelled' | 'http403-expired' | 'http403-rejected' | 'http-other' | 'invalid-body'; status?: number; detail: string }

export async function exchangeAuthCode(
  code: string,
  verifier: string,
  deps: { fetch: typeof fetch; timeoutMs?: number; signal?: AbortSignal },
): Promise<ExchangeResult> {
  const secrets = [code, verifier]
  const timeoutSignal = AbortSignal.timeout(deps.timeoutMs ?? EXCHANGE_TIMEOUT_MS)
  const signal = deps.signal ? AbortSignal.any([timeoutSignal, deps.signal]) : timeoutSignal
  // Celah #2: fetch DAN res.json() dalam SATU try — abort saat baca body ikut terklasifikasi.
  let parsed: unknown = undefined
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
      if (deps.signal?.aborted || timeoutSignal.aborted) throw error // abort saat body → klasifikasi di catch luar
      parsed = undefined // body rusak TANPA abort → invalid-body pada status 200
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
```

- [ ] **Step 4: GREEN + gates** (tsc, lint) — belum commit.

---

### Task 2: orkestrasi login/logout + `readLine` (matriks pesan §6 + kontrak 1–5)

**Files:**
- Modify: `src/login.ts` (tambah `readLine`)
- Create: `src/oauthLogin.ts` bagian orkestrasi (tambah ke file yang sama)
- Test: `test/oauthLogin.test.ts` (lanjut)

**Interfaces:**
- Consumes: Task 1; `saveCredential`/`removeCredential`/`readCredentials` (`src/config.ts` — resolusi prioritas env ada di `resolveModel`, TIDAK diubah).
- Produks:
  - `export function readLine(prompt: string): Promise<string>` — input **terlihat**, `\u0003` → `process.exit(130)` (pola `readSecret` tanpa masking; produksi TIDAK pernah mengembalikan ABORT karena exit langsung).
  - `export const ABORT: unique symbol = Symbol('aborted')` — untuk testability orkestrasi:
    `readLine` injectable boleh mengembalikan `ABORT` ATAU melempar (Ctrl+C) → orkestrasi
    mengembalikan **130** senyap (pola produksi). Rev #3: membedakan kelas — prompt-cancel
    = 130 senyap; exchange-cancel = 130 + `Login cancelled.`; timeout/network = exit 1.
  - `export interface OauthLoginDeps { out(s: string): void; err(s: string): void; env: NodeJS.ProcessEnv; isTTY: boolean; open(url: string): void; readLine(prompt: string): Promise<string | typeof ABORT>; saveCredential(id: string, key: string): void; fetch: typeof fetch; timeoutMs?: number }` —
    tanpa `as never`/cast liar di signature maupun test (rev #4).
  - `export async function runOauthLogin(deps: OauthLoginDeps): Promise<number>` —
    SIGINT listener dipasang **hanya selama exchange** + dibersihkan di `finally`.
  - `export interface OauthLogoutDeps { out(s: string): void; err(s: string): void; env: NodeJS.ProcessEnv; removeCredential(id: string): boolean }`
  - `export async function runOauthLogout(deps: OauthLogoutDeps): Promise<number>` —
    env-note dicetak bila env ada **tanpa syarat credential** (rev #4); revoke URL selalu.

- [ ] **Step 1: Test tambahan (RED)** — tambah di `test/oauthLogin.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globalConfigPath, readCredentials, saveCredential } from '../src/config'
import { ABORT, runOauthLogin, runOauthLogout } from '../src/oauthLogin'

function loginHarness(over: Partial<Parameters<typeof runOauthLogin>[0]> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bccli-oauth-'))
  const env = { BCCLI_HOME: home } as NodeJS.ProcessEnv
  const out: string[] = []
  const err: string[] = []
  const deps = {
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    env,
    isTTY: true,
    open: () => {},
    readLine: async () => 'AUTH-CODE-1',
    saveCredential: (id: string, key: string) => saveCredential(id, key, env),
    fetch: (async () => new Response(JSON.stringify({ key: 'sk-or-v1-SECRETKEY' }), { status: 200 })) as typeof fetch,
    ...over,
  }
  return { deps, out, err, home, env, all: () => [...out, ...err].join('\n') }
}

test('sukses + credential tersimpan + env-absen → pesan tanpa catatan prioritas; key/verifier tak bocor', async () => {
  const h = loginHarness()
  expect(await runOauthLogin(h.deps)).toBe(0)
  expect(readCredentials(h.env).openrouter).toBe('sk-or-v1-SECRETKEY')
  expect(h.all()).toContain('Logged in: openrouter credential saved.')
  expect(h.all()).not.toContain('takes priority')
  // kontrak #5: secret tak pernah muncul
  expect(h.all()).not.toContain('sk-or-v1-SECRETKEY')
  expect(h.all()).not.toContain('AUTH-CODE-1')
})

test('kontrak #1: env OPENROUTER_API_KEY ter-set → sukses DENGAN catatan prioritas env', async () => {
  const h = loginHarness({ env: { BCCLI_HOME: undefined, OPENROUTER_API_KEY: 'env-key-x' } as NodeJS.ProcessEnv })
  ;(h.deps as { env: NodeJS.ProcessEnv }).env = { ...h.deps.env, BCCLI_HOME: h.home }
  expect(await runOauthLogin(h.deps)).toBe(0)
  expect(h.all()).toContain('takes priority')
  expect(h.all()).toContain('OPENROUTER_API_KEY')
})

test('kontrak #1 resolusi: env menang atas credential (resolveModel), credential saja → credential', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-oauth-'))
  const env = { BCCLI_HOME: home } as NodeJS.ProcessEnv
  saveCredential('openrouter', 'stored-key', env)
  writeFileSync(globalConfigPath(env), JSON.stringify({ providers: { openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' } } }))
  const { loadConfig, resolveModel } = await import('../src/config')
  const cfg = loadConfig(process.cwd(), env)
  expect(resolveModel(cfg, 'openrouter/x', { ...env, OPENROUTER_API_KEY: 'env-key' }).apiKey).toBe('env-key')
  expect(resolveModel(cfg, 'openrouter/x', env).apiKey).toBe('stored-key')
})

test('kontrak #2 timeout: pesan timeout, saveCredential tak terpanggil, credential lama utuh', async () => {
  const h = loginHarness({
    fetch: (async () => {
      const e = new Error('timeout'); e.name = 'TimeoutError'; throw e
    }) as typeof fetch,
    timeoutMs: 5,
  })
  saveCredential('openrouter', 'OLD-KEY', h.env)
  expect(await runOauthLogin(h.deps)).toBe(1)
  expect(h.all()).toContain('timed out')
  expect(h.all()).toContain('was not changed')
  expect(readCredentials(h.env).openrouter).toBe('OLD-KEY')
  expect(h.all()).not.toContain('OLD-KEY')
})

test('kontrak #2 kode kosong: fetch 0 panggilan, exit 1, credential utuh', async () => {
  let called = 0
  const h = loginHarness({
    readLine: async () => '   ',
    fetch: (async () => { called++; return new Response('{}') }) as typeof fetch,
  })
  saveCredential('openrouter', 'OLD-KEY', h.env)
  expect(await runOauthLogin(h.deps)).toBe(1)
  expect(called).toBe(0)
  expect(h.all()).toContain('Authorization code is empty')
  expect(readCredentials(h.env).openrouter).toBe('OLD-KEY')
})

test('kontrak #2 Ctrl+C (ABORT dari readLine) → exit 130, tanpa tulis', async () => {
  const h = loginHarness({ readLine: async () => ABORT })
  saveCredential('openrouter', 'OLD-KEY', h.env)
  expect(await runOauthLogin(h.deps)).toBe(130)
  expect(readCredentials(h.env).openrouter).toBe('OLD-KEY')
})

test('kontrak #3: 403 expired → pesan expired; 403 invalid → pesan rejected TANPA kata expired; cross-assert', async () => {
  const mk = (body: unknown) => loginHarness({ fetch: (async () => new Response(JSON.stringify(body), { status: 403 })) as typeof fetch })
  const a = mk({ error: 'Authorization code expired: restart' })
  expect(await runOauthLogin(a.deps)).toBe(1)
  expect(a.all()).toContain('codes are valid for 10 minutes')
  const b = mk({ error: 'invalid code or verifier' })
  expect(await runOauthLogin(b.deps)).toBe(1)
  expect(b.all()).toContain('rejected the authorization code (403)')
  expect(b.all()).not.toContain('expired')
  expect(b.all()).not.toContain('10 minutes')
  const c = mk({})
  expect(await runOauthLogin(c.deps)).toBe(1)
  expect(c.all()).not.toContain('expired') // body kosong ≠ expired
})

test('kontrak #4: exchange sukses tapi saveCredential gagal → pesan remote-created + belum lokal + dashboard', async () => {
  const h = loginHarness({
    saveCredential: () => { throw new Error('EACCES denied') },
  })
  expect(await runOauthLogin(h.deps)).toBe(1)
  const text = h.all()
  expect(text).toContain('created on your OpenRouter account')
  expect(text).toContain('could not be saved locally')
  expect(text).toContain('https://openrouter.ai/settings/keys')
  expect(text).toContain('EACCES denied')
  expect(text).not.toContain('sk-or-v1-SECRETKEY')
})

test('kontrak #5 redact: network error berisi secret → output memuat *** bukan secret', async () => {
  const h = loginHarness({
    readLine: async () => 'CODE-WITH-SECRET',
    fetch: (async () => { throw new TypeError('failed sending CODE-WITH-SECRET and VERIF-XYZ') }) as typeof fetch,
  })
  expect(await runOauthLogin(h.deps)).toBe(1)
  expect(h.all()).toContain('Could not reach OpenRouter')
  expect(h.all()).toContain('***')
  expect(h.all()).not.toContain('CODE-WITH-SECRET')
  expect(h.all()).not.toContain('VERIF-XYZ')
})

test('non-TTY tanpa --key: exit 1, instruksi --key, open TIDAK dipanggil', async () => {
  let opened = 0
  const h = loginHarness({ isTTY: false, open: () => { opened++ } })
  expect(await runOauthLogin(h.deps)).toBe(1)
  expect(opened).toBe(0)
  expect(h.all()).toContain('--key')
})

test('runOauthLogout: removed → pesan + URL revoke; tak ada credential → "not stored" + revoke TETAP dicetak', async () => {
  const out1: string[] = []
  expect(await runOauthLogout({ out: (s) => out1.push(s), err: () => {}, env: {}, removeCredential: () => true })).toBe(0)
  expect(out1.join('\n')).toContain('openrouter credential removed.')
  expect(out1.join('\n')).toContain('https://openrouter.ai/settings/keys')
  const out2: string[] = []
  expect(await runOauthLogout({ out: (s) => out2.push(s), err: () => {}, env: {}, removeCredential: () => false })).toBe(0)
  expect(out2.join('\n')).toContain('was not stored')
  expect(out2.join('\n')).toContain('https://openrouter.ai/settings/keys') // revoke selalu
  expect(out2.join('\n')).not.toContain('still set')
})

test('kontrak #1-rev#4: env note TAMPUL walau credential lokal tidak ada (not stored + still set)', async () => {
  const out: string[] = []
  const env = { OPENROUTER_API_KEY: 'env-x' }
  expect(await runOauthLogout({ out: (s) => out.push(s), err: () => {}, env, removeCredential: () => false })).toBe(0)
  const text = out.join('\n')
  expect(text).toContain('was not stored')
  expect(text).toContain('still set in the environment')
  expect(text).toContain('OPENROUTER_API_KEY')
  expect(text).toContain('https://openrouter.ai/settings/keys')
  expect(text).not.toContain('env-x') // nilai env tidak dicetak
})

test('kontrak #2b-rev#3: SIGINT selama exchange → Login cancelled + 130 + credential utuh + listener bersih', async () => {
  const baseline = process.listenerCount('SIGINT')
  let started: () => void = () => {}
  const startedP = new Promise<void>((r) => (started = r))
  const h = loginHarness({
    fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      started()
      await new Promise<void>((_r, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
      return new Response('{}')
    }) as typeof fetch,
  })
  saveCredential('openrouter', 'OLD-KEY', h.env)
  const p = runOauthLogin(h.deps)
  await startedP // fetch sudah berjalan → listener SIGINT terpasang
  expect(process.listenerCount('SIGINT')).toBe(baseline + 1)
  process.emit('SIGINT') // JS emit: memanggil listener tanpa membunuh proses
  expect(await p).toBe(130)
  expect(h.all()).toContain('Login cancelled.')
  expect(readCredentials(h.env).openrouter).toBe('OLD-KEY')
  expect(process.listenerCount('SIGINT')).toBe(baseline)
})

test('listener SIGINT pulih (finally) di jalur sukses & network error', async () => {
  const baseline = process.listenerCount('SIGINT')
  expect(await runOauthLogin(loginHarness().deps)).toBe(0)
  const net = loginHarness({
    fetch: (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch,
  })
  expect(await runOauthLogin(net.deps)).toBe(1)
  expect(net.all()).toContain('Could not reach OpenRouter')
  expect(process.listenerCount('SIGINT')).toBe(baseline)
})

/** Header 200 diterman langsung; res.json() tertahan sampai signal abort (celah #2). */
function headersThenHang(onHeaders: () => void): typeof fetch {
  return (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const res = new Response('{"key":"k"}', { status: 200 })
    Object.defineProperty(res, 'json', {
      value: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('body aborted')))
        }),
    })
    onHeaders()
    return res
  }) as typeof fetch
}

test('celah #1: readLine error I/O biasa → exit 1 + pesan aman (bukan 130); credential utuh; listener baseline', async () => {
  const baseline = process.listenerCount('SIGINT')
  const h = loginHarness({
    readLine: async () => {
      throw new Error('EIO: stdin failure')
    },
  })
  saveCredential('openrouter', 'OLD-KEY', h.env)
  expect(await runOauthLogin(h.deps)).toBe(1)
  expect(h.all()).toContain('Failed to read the authorization code')
  expect(h.all()).toContain('EIO: stdin failure')
  expect(h.all()).not.toContain('Login cancelled')
  expect(readCredentials(h.env).openrouter).toBe('OLD-KEY')
  expect(process.listenerCount('SIGINT')).toBe(baseline)
})

test('celah #2a: headers 200 → body tertahan sampai timeout → pesan timeout, BUKAN invalid-body', async () => {
  const baseline = process.listenerCount('SIGINT')
  let headers: () => void = () => {}
  const got = new Promise<void>((r) => (headers = r))
  const h = loginHarness({ fetch: headersThenHang(() => headers()), timeoutMs: 25 })
  saveCredential('openrouter', 'OLD-KEY', h.env)
  const p = runOauthLogin(h.deps)
  await got // fetch sudah masuk → listener SIGINT terpasang
  expect(process.listenerCount('SIGINT')).toBe(baseline + 1)
  expect(await p).toBe(1)
  expect(h.all()).toContain('timed out')
  expect(h.all()).not.toContain('expected format') // BUKAN invalid-body
  expect(readCredentials(h.env).openrouter).toBe('OLD-KEY')
  expect(process.listenerCount('SIGINT')).toBe(baseline)
})

test('celah #2b: headers 200 → body tertahan → SIGINT → 130 + Login cancelled, BUKAN invalid-body', async () => {
  const baseline = process.listenerCount('SIGINT')
  let headers: () => void = () => {}
  const got = new Promise<void>((r) => (headers = r))
  const h = loginHarness({ fetch: headersThenHang(() => headers()) })
  saveCredential('openrouter', 'OLD-KEY', h.env)
  const p = runOauthLogin(h.deps)
  await got
  expect(process.listenerCount('SIGINT')).toBe(baseline + 1)
  process.emit('SIGINT')
  expect(await p).toBe(130)
  expect(h.all()).toContain('Login cancelled.')
  expect(h.all()).not.toContain('expected format') // BUKAN invalid-body
  expect(readCredentials(h.env).openrouter).toBe('OLD-KEY')
  expect(process.listenerCount('SIGINT')).toBe(baseline)
})

test('celah #2c: JSON malformed TANPA abort → invalid-body (bukan cancelled/timeout); credential utuh; listener baseline', async () => {
  const baseline = process.listenerCount('SIGINT')
  const h = loginHarness({ fetch: (async () => new Response('not-json{{{', { status: 200 })) as typeof fetch })
  saveCredential('openrouter', 'OLD-KEY', h.env)
  expect(await runOauthLogin(h.deps)).toBe(1)
  expect(h.all()).toContain('did not return an API key in the expected format')
  expect(h.all()).not.toContain('timed out')
  expect(h.all()).not.toContain('Login cancelled')
  expect(readCredentials(h.env).openrouter).toBe('OLD-KEY')
  expect(process.listenerCount('SIGINT')).toBe(baseline)
})

- [ ] **Step 2: Implementasi orkestrasi** (tambah di `src/oauthLogin.ts` + `readLine` di `src/login.ts`):

```ts
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
        deps.err(t('The exchange with OpenRouter timed out after {seconds}s. Your stored credential was not changed.', { seconds: String(Math.round((deps.timeoutMs ?? EXCHANGE_TIMEOUT_MS) / 1000)) }))
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
        reason: redact((error as Error).message, [result.key, trimmed, verifier]),
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
```

`readLine` di `src/login.ts` (salinan struktur `readSecret` tanpa masking; `\u0003` → `process.exit(130)`; non-TTY → baca sampai EOF).

- [ ] **Step 3: GREEN + gates.**

---

### Task 3: wiring — flag `--key`/`--logout`, dispatch `login`, HELP + i18n

**Files:**
- Modify: `src/args.ts` (flag), `src/login.ts` (dispatch `runLogin`), `src/i18n/id.ts`, HELP baris
- Test: `test/args.test.ts`, `test/oauthLogin.test.ts` (dispatch), i18n test

**Interfaces:**
- Consumes: Task 2.
- Produks: perilaku CLI penuh sesuai spec §2.

- [ ] **Step 1: Test args RED**:

```ts
test('login flags: --key dan --logout', () => {
  expect(parseCliArgs(['login', 'openrouter', '--key'])).toMatchObject({ command: 'login', loginProvider: 'openrouter', key: true, logout: false })
  expect(parseCliArgs(['login', 'openrouter', '--logout'])).toMatchObject({ logout: true, key: false })
})
```

- [ ] **Step 2: Implementasi args** — opsi `key: {type:'boolean'}`, `logout: {type:'boolean'}`; field `key: boolean` / `logout: boolean` di `CliArgs` (default false).

- [ ] **Step 3: Dispatch `runLogin` — kode NYATA dengan interface deps (rev #5)**:

```ts
// src/login.ts
import type { CliArgs } from './args'
import type { ABORT } from './oauthLogin'
// + import { defaultOpen } from './mcp/oauth' — import { removeCredential, saveCredential } from './config'
// + import { t } from './i18n'  (readLine & readSecret ada di file ini)

export interface LoginDeps {
  out(s: string): void
  err(s: string): void
  env: NodeJS.ProcessEnv
  isTTY: boolean
  open(url: string): void
  readLine(prompt: string): Promise<string | typeof ABORT>
  saveCredential(id: string, key: string): void
  removeCredential(id: string): boolean
  fetch: typeof fetch
  legacyAdd(providerId: string, cwd: string): Promise<number>
}

export function defaultLoginDeps(): LoginDeps {
  return {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
    env: process.env,
    isTTY: process.stdin.isTTY ?? false,
    open: (url) => defaultOpen(new URL(url)),
    readLine,
    saveCredential: (id, key) => saveCredential(id, key, process.env),
    removeCredential: (id) => removeCredential(id, process.env),
    fetch: globalThis.fetch,
    // Wiring NYATA jalur lama (celah placeholder → implementasi): persis runLogin lama
    // (login.ts:35-42) — dynamic import, CliDeps {env, cwd, out, err, readSecret}.
    legacyAdd: async (providerId, targetCwd) => {
      const { runProviderCommand } = await import('./providerCli')
      const { parseCliArgs: parse } = await import('./args')
      return runProviderCommand(parse(['provider', 'add', providerId]), {
        env: process.env,
        cwd: targetCwd,
        out: (s) => console.log(s),
        err: (s) => console.error(s),
        readSecret,
      })
    },
  }
}

export async function runLogin(providerId: string, cwd: string, args: CliArgs, deps: LoginDeps): Promise<number> {
  // Urutan ketat spec §8 — konflik PALING AWAL (kontrak #6): sebelum open/readLine/save/remove.
  if (args.key && args.logout) {
    deps.err(t('Use either --key or --logout, not both.'))
    return 1
  }
  if (args.logout) {
    if (providerId !== 'openrouter') {
      // Rev #5: logout OAuth hanya openrouter — TIDAK PERNAH diam-diam menghapus credential lain.
      deps.err(t('Logout is not supported for {id}; use bccli provider remove {id} to delete its stored key and config.', { id: providerId }))
      return 1
    }
    const { runOauthLogout } = await import('./oauthLogin')
    return runOauthLogout({ out: deps.out, err: deps.err, env: deps.env, removeCredential: deps.removeCredential })
  }
  if (args.key) return deps.legacyAdd(providerId, cwd)
  if (providerId === 'openrouter') {
    const { runOauthLogin } = await import('./oauthLogin')
    return runOauthLogin({
      out: deps.out, err: deps.err, env: deps.env, isTTY: deps.isTTY, open: deps.open,
      readLine: deps.readLine, saveCredential: deps.saveCredential, fetch: deps.fetch,
    })
  }
  return deps.legacyAdd(providerId, cwd) // provider non-openrouter: jalur lama TIDAK berubah
}
```

**Test dispatch** (pakai `LoginDeps` + spy — `open`/`readLine`/`saveCredential`/
`removeCredential`/`legacyAdd` semuanya dihitung; **tanpa `as never`**):

```ts
function dispatchHarness(args: Partial<CliArgs>, over: Partial<LoginDeps> = {}) {
  const calls = { open: 0, readLine: 0, save: 0, remove: 0, legacy: [] as string[] }
  const deps: LoginDeps = {
    out: () => {}, err: () => {}, env: {}, isTTY: true,
    open: () => { calls.open++ },
    readLine: async () => { calls.readLine++; return 'CODE' },
    saveCredential: () => { calls.save++ },
    removeCredential: () => { calls.remove++; return true },
    fetch: (async () => new Response('{"key":"k"}', { status: 200 })) as typeof fetch,
    legacyAdd: async (id) => { calls.legacy.push(id); return 0 },
    ...over,
  }
  const full = { ...parseCliArgs(['login', 'openrouter']), ...args } as CliArgs
  return { calls, run: () => runLogin('openrouter', '.', full, deps), deps }
}

test('kontrak #6: --key --logout → exit 1, SEMUA spy nol panggilan (urutan guard)', async () => {
  const h = dispatchHarness({ key: true, logout: true })
  expect(await h.run()).toBe(1)
  expect(h.calls).toEqual({ open: 0, readLine: 0, save: 0, remove: 0, legacy: [] })
})

test('rev #5: logout provider LAIN ditolak — removeCredential TIDAK dipanggil', async () => {
  const h = dispatchHarness({ logout: true })
  h.calls.remove = 0
  const r = await runLogin('groq', '.', { ...parseCliArgs(['login', 'groq']), logout: true, key: false } as CliArgs, h.deps)
  expect(r).toBe(1)
  expect(h.calls.remove).toBe(0) // tidak pernah diam-diam menghapus credential yang salah
  expect(h.calls.legacy).toEqual([]) // pun pesan sendiri, bukan legacy
})

test('dispatch: openrouter --logout → removeCredential openrouter; --key → legacy; default openrouter → oauth; provider lain → legacy', async () => {
  const a = dispatchHarness({ logout: true })
  expect(await a.run()).toBe(0)
  expect(a.calls.remove).toBe(1)
  const b = dispatchHarness({ key: true })
  expect(await b.run()).toBe(0)
  expect(b.calls.legacy).toEqual(['openrouter'])
  expect(b.calls.open).toBe(0)
  const c = dispatchHarness({}) // default openrouter → jalur OAuth (open terpanggil)
  expect(await c.run()).toBe(0)
  expect(c.calls.open).toBe(1)
  const d = dispatchHarness({})
  const r = await runLogin('groq', '.', parseCliArgs(['login', 'groq']), d.deps)
  expect(r).toBe(0)
  expect(d.calls.legacy).toEqual(['groq'])
})
```

- [ ] **Step 3b: update pemanggil di `src/cli.ts`** — baris lama
  `if (args.command === 'login') return runLogin(args.loginProvider ?? 'bc-cloud', cwd)`
  menjadi
  `if (args.command === 'login') return runLogin(args.loginProvider ?? 'bc-cloud', cwd, args, defaultLoginDeps())`
  (`defaultLoginDeps` diimpor dari `./login`). Tanpa perubahan dispatch lain.

- [ ] **Step 4: HELP + i18n** — baris HELP EN (kolom 32):
  `  bccli login [provider]        OAuth login (or --key paste API key, --logout remove)`
  nilai ID: `  bccli login [provider]        login OAuth (atau --key tempel API key, --hapus logout)` — plus semua key pesan Task 1–2 (daftar persis teks EN di kode Task 2 + task1) diterjemahkan ke `id.ts`; test i18n hijau.

- [ ] **Step 5: GREEN + gates.**

---

### Task 4: gates penuh 2×, AGENTS.md, laporan (login nyata DITAHAN)

- [ ] **Step 1: Gates 2×** — tsc 0, lint 0/0, `npm test` (2× stabil), build OK.
- [ ] **Step 2: Canary login OAuth live — DITAHAN** (interaktif butuh browser + akun OpenRouter user; larangan "jangan jalankan login nyata" berlaku sampai izin terpisah).
- [ ] **Step 3: AGENTS.md** — bullet sub-proyek #3 (fitur, kontrak, 6 ketentuan user, deviasi, gates, canary-ditahan).
- [ ] **Step 4: Laporan** — tabel kontrak→tes, gates, commit list, keterbatasan (§9 spec: saveCredential non-atomik, tanpa auto-verify, tanpa state, canary ditahan) + tanya sub-proyek #4 (gh-bot) atau rilis.

---

## Self-Review (penulis)

1. **Spec coverage**: §2 perintah (+tolakan logout provider lain)→Task 3; §3 flow + status/payload 200→Task 1 (PKCE/URL/exchange) + Task 2 (orkestrasi); §4 prioritas env + logout env-note-selalu→Task 2 test resolusi + pesan login/logout; §5 penyimpanan/refresh/revoke→Task 2 logout + pesan (tanpa refresh = keputusan tercatat); §6 matriks a–i + b2 + taksonomi cancel/timeout/network→Task 1 (kind cancelled) + Task 2 (SIGINT wiring + test); §7 pipeline redact→truncate + tes boundary→Task 1 (safeDetail + test stub-verifier); §8 arsitektur signature FINAL (LoginDeps/runLogin nyata; tanpa `hasStored` — sudah selaras, tanpa `as never`)→Task 2–3; §9 keterbatasan→Task 4 laporan; §10 test matrix (1–14)→Task 1–3.
2. **Placeholder**: tidak ada TBD; draft lama (envWithKey/as-never/pseudocode dispatch) sudah DIGANTI kode nyata — tidak ada instruksi "sesuaikan saat implementasi" yang tersisa.
3. **Konsistensi tipe**: `ExchangeResult` (8 kind, termasuk `cancelled`) identik Task 1↔2; `OauthLoginDeps.readLine: Promise<string | typeof ABORT>` konsisten test/implementasi/dispatch; `LoginDeps` identik spesifikasi↔uji; URL konstan hanya `OPENROUTER_*_URL`; secrets `[code, verifier]` (+ `key` di jalur save-fail) konsisten dengan §7; exit code 0/1/130 sesuai taksonomi §6.
4. **6 kontrak + 5 revisi + 2 celah user**: #1 Task 2 (2 test + resolusi + logout env-semua-kondisi), #2 Task 2 (timeout/empty/ABORT/old-utuh + SIGINT-exchange + listener baseline), #3 Task 1 (classify) + Task 2 (cross-assert), #4 Task 2 (save-fail), #5 Task 1 (redact unit + boundary stub-verifier) + Task 2 (sukses + network gelap), #6 Task 3 (guard urutan + spy nol); rev #1 pipeline→Task 1 `safeDetail`, rev #2 status/payload→Task 1 (5 kasus), rev #3 taksonomi/cleanup→Task 1+2, rev #4 env-note+signature→Task 2, rev #5 dispatch nyata+logout-provider-lain→Task 3; **celah #1** → catch `readLine` terklasifikasi (`isReadCancel`) + test I/O, **celah #2** → exchange satu-try dgn klasifikasi asal-signal di seluruh `fetch`+`res.json()` + 3 test body-read (2a/2b/2c), `legacyAdd` placeholder → wiring nyata `runProviderCommand`+`CliDeps` + step 3b `cli.ts`.
