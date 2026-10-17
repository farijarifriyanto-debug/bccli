# `bccli serve` (Session Server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** server lokal (HTTP unary + WebSocket mux) yang mengekspos sesi agent bccli secara persisten multi-turn kepada proses eksternal (IDE, bot, Switchboard), mengikuti pola DSH (trust fence + token, disiplin `ready`, approvals fail-closed + replay pending).

**Architecture:** dua modul baru — `src/serveProtocol.ts` (framing murni + trust fence + bearer, tanpa I/O) dan `src/serve.ts` (`startServe()` → node:http server + upgrade WS via dep `ws` yang SUDAH ada, registry sesi in-memory di atas `createRuntime`/`Agent`/`Session` JSONL yang ada). CLI wiring mengikuti pola subcommand `acp`/`models`.

**Tech Stack:** Node ≥22, TypeScript strict, node:http, `ws@^8.22.0` (dependencies) + `@types/ws` (devDependencies, sudah ada), vitest 5, tanpa dependency baru.

**Spec:** `docs/superpowers/specs/2026-10-07-serve-design.md`

## Global Constraints

- TANPA dependency npm baru (`ws` + `@types/ws` sudah ada di package.json).
- Semua string user-facing lewat `t('...')` + key di `src/i18n/id.ts` (test i18n menolak key hilang/stale; HELP adalah SATU key template literal — key EN di `src/args.ts` dan key+nilai di `id.ts` harus byte-identik).
- Suite vitest berjalan dalam bahasa Indonesia (`test/setup.ts` → `setLanguage('id')`).
- Loopback-only: nilai `--host` selain `127.0.0.1`/`localhost`/`::1` ditolak fail-loud saat parse (spec §3: `0.0.0.0` TIDAK didukung).
- Token default = 32-byte hex acak; perbandingan timing-safe; token tidak pernah lewat query string.
- Edit file HANYA via tool edit/write (PowerShell `Set-Content` merusak UTF-8 — gotcha AGENTS.md).
- Gates tiap task: `npx tsc --noEmit -p tsconfig.json` 0 error; `npm run lint` 0/0; `npm test` hijau. Rilis/push DITAHAN.
- Commit style repo: `feat:`/`fix:`/`docs:`/`test:` lowercase imperative.

## Catatan koreksi spec (dikerjakan di Task 6)

Spec §8 menulis item `approval_request {requestId, tool, input, preview}`; `PermissionAsk` riil punya `target` (bukan `input`). Wire final: `{type:'approval_request', requestId, tool, kind, target, preview?}` — Task 6 menyunting spec agar cocok (§6/§8 `input`→`target`, tambah `kind`).

---

### Task 1: `src/serveProtocol.ts` — framing murni + trust fence + bearer

**Files:**
- Create: `src/serveProtocol.ts`
- Test: `test/serveProtocol.test.ts`

**Interfaces:**
- Consumes: tidak ada (modul murni, hanya `node:crypto`).
- Produces (dipakai Task 2–5):
  - `type ClientFrame = { type: 'open'; streamId: string; target: string } | { type: 'cancel'; streamId: string }`
  - `type ServerFrame = { type: 'item'; streamId: string; value: unknown } | { type: 'end'; streamId: string } | { type: 'error'; streamId: string; message: string }`
  - `parseClientFrame(raw: string): ClientFrame | { error: string }`
  - `trustFence(headers: { host?: string; origin?: string; 'sec-fetch-site'?: string }, port: number): string | null` (null = lolos; string = alasan 403)
  - `bearerOk(header: string | undefined, token: string): boolean`
  - `randomToken(): string`
  - `MAX_FRAME_BYTES = 262144`

- [ ] **Step 1: Tulis test gagal** — `test/serveProtocol.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { MAX_FRAME_BYTES, bearerOk, parseClientFrame, randomToken, trustFence } from '../src/serveProtocol'

describe('parseClientFrame', () => {
  test('open valid', () => {
    expect(parseClientFrame('{"type":"open","streamId":"a","target":"session:x"}')).toEqual({
      type: 'open', streamId: 'a', target: 'session:x',
    })
  })
  test('cancel valid', () => {
    expect(parseClientFrame('{"type":"cancel","streamId":"a"}')).toEqual({ type: 'cancel', streamId: 'a' })
  })
  test('json rusak → error', () => {
    expect(parseClientFrame('{')).toMatchObject({ error: expect.any(String) })
  })
  test('type tak dikenal → error', () => {
    expect(parseClientFrame('{"type":"item","streamId":"a"}')).toMatchObject({ error: expect.any(String) })
  })
  test('open tanpa target → error', () => {
    expect(parseClientFrame('{"type":"open","streamId":"a"}')).toMatchObject({ error: expect.any(String) })
  })
})

describe('trustFence', () => {
  const H = (over: Record<string, string> = {}) => ({ host: `127.0.0.1:8787`, ...over })
  test('loopback polos lolos', () => expect(trustFence(H(), 8787)).toBeNull())
  test('localhost + ::1 lolos', () => {
    expect(trustFence(H({ host: 'localhost:8787' }), 8787)).toBeNull()
    expect(trustFence(H({ host: '[::1]:8787' }), 8787)).toBeNull()
  })
  test('Host non-loopback → alasan 403', () => expect(trustFence(H({ host: 'evil.com' }), 8787)).toBeTruthy())
  test('port Host tidak cocok listener → 403', () => expect(trustFence(H({ host: '127.0.0.1:9999' }), 8787)).toBeTruthy())
  test('Origin beda → 403; Origin sama → lolos', () => {
    expect(trustFence(H({ origin: 'http://evil.com' }), 8787)).toBeTruthy()
    expect(trustFence(H({ origin: 'http://127.0.0.1:8787' }), 8787)).toBeNull()
  })
  test('sec-fetch-site cross-site → 403; same-origin → lolos', () => {
    expect(trustFence(H({ 'sec-fetch-site': 'cross-site' }), 8787)).toBeTruthy()
    expect(trustFence(H({ 'sec-fetch-site': 'same-origin' }), 8787)).toBeNull()
  })
  test('Host hilang → 403', () => expect(trustFence({ host: undefined }, 8787)).toBeTruthy())
})

describe('bearerOk', () => {
  test('token cocok', () => expect(bearerOk('Bearer abc123', 'abc123')).toBe(true))
  test('token salah / header hilang / skema salah', () => {
    expect(bearerOk('Bearer nope', 'abc123')).toBe(false)
    expect(bearerOk(undefined, 'abc123')).toBe(false)
    expect(bearerOk('abc123', 'abc123')).toBe(false)
  })
})

test('randomToken 64 hex, unik; MAX_FRAME_BYTES 256KB', () => {
  const a = randomToken()
  expect(a).toMatch(/^[0-9a-f]{64}$/)
  expect(randomToken()).not.toBe(a)
  expect(MAX_FRAME_BYTES).toBe(262144)
})
```

- [ ] **Step 2: Jalankan, pastikan RED** — `npx vitest run test/serveProtocol.test.ts` → gagal "Cannot find module '../src/serveProtocol'".

- [ ] **Step 3: Implementasi minimal** — `src/serveProtocol.ts`:

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Wire frames of the /v1/mux WebSocket (subset of the DSH stream protocol). */
export type ClientFrame =
  | { type: 'open'; streamId: string; target: string }
  | { type: 'cancel'; streamId: string }
export type ServerFrame =
  | { type: 'item'; streamId: string; value: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; message: string }

export const MAX_FRAME_BYTES = 262144

export function parseClientFrame(raw: string): ClientFrame | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { error: 'invalid JSON frame' }
  }
  const f = value as { type?: unknown; streamId?: unknown; target?: unknown }
  if (typeof f?.streamId !== 'string' || f.streamId === '') return { error: 'frame requires a streamId' }
  if (f.type === 'open') {
    if (typeof f.target !== 'string' || f.target === '') return { error: 'open requires a target' }
    return { type: 'open', streamId: f.streamId, target: f.target }
  }
  if (f.type === 'cancel') return { type: 'cancel', streamId: f.streamId }
  return { error: `unknown frame type: ${String(f?.type)}` }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * DSH-style trust fence: loopback Host (+ matching port), same-origin Origin,
 * no cross-site sec-fetch-site. Returns null when trusted, else the 403 reason.
 * Never establishes identity — the bearer token does.
 */
export function trustFence(
  headers: { host?: string; origin?: string; 'sec-fetch-site'?: string },
  port: number,
): string | null {
  const host = headers.host
  if (!host) return 'missing Host header'
  const sep = host.lastIndexOf(':')
  const hostname = sep > -1 ? host.slice(0, sep) : host
  const hostPort = sep > -1 ? Number(host.slice(sep + 1)) : 80
  if (!LOOPBACK_HOSTS.has(hostname)) return `non-loopback Host: ${hostname}`
  if (hostPort !== port) return `Host port ${hostPort} does not match listener ${port}`
  if (headers.origin) {
    let originHost: string | null = null
    try {
      const u = new URL(headers.origin)
      originHost = u.hostname === '::1' ? '[::1]' : u.hostname
      const originPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80
      if (originPort !== port) return 'Origin port mismatch'
    } catch {
      return 'malformed Origin header'
    }
    if (originHost && !LOOPBACK_HOSTS.has(originHost)) return `cross-origin Origin: ${headers.origin}`
    if (originHost && originHost !== hostname && !(originHost === '[::1]' && hostname === 'localhost')) {
      // 127.0.0.1 vs localhost vs [::1] are all the same machine; require loopback on both sides only.
    }
  }
  if (headers['sec-fetch-site'] === 'cross-site') return 'cross-site request'
  return null
}

/** Timing-safe `Authorization: Bearer <token>` check. */
export function bearerOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false
  const got = Buffer.from(header.slice(7))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

export function randomToken(): string {
  return randomBytes(32).toString('hex')
}
```

(Catatan: blok if-kosong di Origin dihapus saat implementasi — biarkan hanya cek `LOOPBACK_HOSTS.has(originHost)`; kode di atas menampilkan niat, sederhanakan agar lint `noUselessIf` tidak menyalak.)

- [ ] **Step 4: Jalankan, pastikan GREEN** — `npx vitest run test/serveProtocol.test.ts` → semua pass.
- [ ] **Step 5: Gates + commit**:

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
git add src/serveProtocol.ts test/serveProtocol.test.ts
git commit -m "feat: serve wire protocol — mux frames, trust fence, bearer check"
```

---

### Task 2: `startServe()` — health, auth, sesi CRUD (unary HTTP)

**Files:**
- Create: `src/serve.ts`
- Test: `test/serve.test.ts`

**Interfaces:**
- Consumes: Task 1 (`trustFence`, `bearerOk`, `randomToken`); `createRuntime`/`Runtime` (`src/setup.ts`), `parseCliArgs` (`src/args.ts`), `Session` + `bccliHome` + `loadConfig` (`src/session.ts`, `src/config.ts`), `listAllModels` (`src/models.ts`).
- Produces (dipakai Task 3–6):
  - `interface ServeOptions { port?: number; host?: string; token?: string; cwd?: string; env?: NodeJS.ProcessEnv; provider?: Provider; fetch?: typeof fetch; heartbeatMs?: number; err?: (s: string) => void }`
  - `interface ServeHandle { port: number; token: string; url: string; close(): Promise<void> }`
  - `startServe(opts: ServeOptions): Promise<ServeHandle>` (port 0 → ephemeral; `handle.port` = port aktual)
  - `jsonError(res, status, message)` internal; route table internal.

- [ ] **Step 1: Tulis test gagal** — `test/serve.test.ts` (harness bersama dipakai task berikutnya juga):

```ts
import { mkdtempSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { Provider } from '../src/provider'
import { startServe, type ServeHandle } from '../src/serve'

// Stub provider pola test/sdk.test.ts (WAJIB panggil req.onText agar agent emit 'text').
function scripted(texts: string[]): Provider {
  let n = 0
  return {
    async chat(req) {
      const text = texts[Math.min(n++, texts.length - 1)]
      if (text) req.onText?.(text)
      return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
    },
    async listModels() {
      return ['serve-model']
    },
  }
}

export async function withServe(texts: string[], fn: (ctx: { h: ServeHandle; base: string }) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'bccli-serve-'))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-serve-cwd-'))
  const h = await startServe({
    port: 0, cwd, provider: scripted(texts),
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv,
  })
  try {
    await fn({ h, base: `http://127.0.0.1:${h.port}` })
  } finally {
    await h.close()
  }
}

export function api(base: string, token: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
}

/** Raw node:http request — fetch melarang header Host/Origin; trust fence butuh keduanya. */
export function raw(base: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const u = new URL(`${base}${path}`)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('health tanpa token → 200 {ok,version}; /v1/models tanpa token → 401', async () => {
  await withServe(['hi'], async ({ h, base }) => {
    const health = await fetch(`${base}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ ok: true, version: expect.any(String) })
    const unauth = await fetch(`${base}/v1/models`)
    expect(unauth.status).toBe(401)
    expect(await unauth.json()).toMatchObject({ error: { message: expect.any(String) } })
  })
})

test('trust fence: Host non-loopback → 403 bahkan dengan token benar', async () => {
  await withServe(['hi'], async ({ h, base }) => {
    const res = await raw(base, '/health', { host: 'evil.com', authorization: `Bearer ${h.token}` })
    expect(res.status).toBe(403)
  })
})

test('trust fence: Origin cross → 403; sec-fetch-site cross-site → 403', async () => {
  await withServe(['hi'], async ({ h, base }) => {
    const a = await raw(base, '/health', { host: `127.0.0.1:${h.port}`, origin: 'http://evil.com' })
    expect(a.status).toBe(403)
    const b = await raw(base, '/health', { host: `127.0.0.1:${h.port}`, 'sec-fetch-site': 'cross-site' })
    expect(b.status).toBe(403)
  })
})

test('POST /v1/sessions → 201 {id,cwd,permissionMode}; GET list memuatnya; GET /:id baseline kosong', async () => {
  await withServe(['hi'], async ({ h, base }) => {
    const created = await api(base, h.token, '/v1/sessions', {})
    expect(created.status).toBe(201)
    const s = (await created.json()) as { id: string; cwd: string; permissionMode: string }
    expect(s.id).toBeTruthy()
    expect(s.permissionMode).toBe('ask')
    const list = await api(base, h.token, `/v1/sessions?cwd=${encodeURIComponent(s.cwd)}`)
    expect(list.status).toBe(200)
    const items = (await list.json()) as { id: string }[]
    expect(items.some((i) => i.id === s.id)).toBe(true)
    const get = await api(base, h.token, `/v1/sessions/${s.id}?cwd=${encodeURIComponent(s.cwd)}`)
    expect(get.status).toBe(200)
    expect(await get.json()).toMatchObject({ id: s.id, messages: [] })
  })
})

test('GET /v1/models → 200 ModelGroup[]; route tak dikenal → 404 JSON; body >1MB → 413', async () => {
  await withServe(['hi'], async ({ h, base }) => {
    const models = await api(base, h.token, '/v1/models')
    expect(models.status).toBe(200)
    const groups = (await models.json()) as { models: string[] }[]
    expect(groups.flatMap((g) => g.models)).toContain('serve-model')
    const missing = await api(base, h.token, '/v1/nope')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { message: expect.any(String) } })
    const big = await api(base, h.token, '/v1/sessions', { prompt: 'x'.repeat(1024 * 1024 + 10) })
    expect(big.status).toBe(413)
  })
})
```

- [ ] **Step 2: Jalankan, pastikan RED** — `npx vitest run test/serve.test.ts` → gagal module tidak ada.

- [ ] **Step 3: Implementasi** — `src/serve.ts` (kerangka unary; mux/turn/approval menyusul di Task 3–5, struktur registry sudah final):

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { parseCliArgs } from './args'
import { bccliHome, loadConfig } from './config'
import { listAllModels } from './models'
import type { Provider } from './provider'
import { Session } from './session'
import { createRuntime, type Runtime } from './setup'
import { bearerOk, randomToken, trustFence } from './serveProtocol'

export interface ServeOptions {
  port?: number
  host?: string
  token?: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  provider?: Provider
  fetch?: typeof fetch
  heartbeatMs?: number
  err?: (s: string) => void
}
export interface ServeHandle {
  port: number
  token: string
  url: string
  close(): Promise<void>
}

export type PermissionMode = 'ask' | 'bypassPermissions'

interface ServedSession {
  id: string
  cwd: string
  rt: Runtime
  permissionMode: PermissionMode
  busy: { turnId: string; controller: AbortController } | null
  streams: Set<string> // streamId (Task 3)
  // Bentuk final (dipakai Task 4): req = PermissionAsk utk replay pending saat stream dibuka ulang.
  pending: Map<string, { resolve: (a: 'yes' | 'session' | 'all' | 'no') => void; req: import('./agent').PermissionAsk }>
}

const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1'])

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
const jsonError = (res: ServerResponse, status: number, message: string): void => json(res, status, { error: { message } })

function readBody(req: IncomingMessage): Promise<string | { tooLarge: true }> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c: Buffer) => {
      body += c
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('tooLarge'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export async function startServe(opts: ServeOptions = {}): Promise<ServeHandle> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK_BIND.has(host)) throw new Error(`serve refuses non-loopback --host ${host} (loopback only)`)
  const token = opts.token ?? env.BCCLI_SERVE_TOKEN ?? randomToken()
  const home = bccliHome(env)
  const sessions = new Map<string, ServedSession>()

  const server: Server = createServer((req, res) => {
    void handleHttp(req, res)
  })

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = (server.address() as { port: number }).port
    const fence = trustFence(req.headers as never, port)
    if (fence) return jsonError(res, 403, fence)
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    if (url.pathname !== '/health' && !bearerOk(req.headers.authorization, token)) {
      return jsonError(res, 401, 'missing or invalid bearer token')
    }
    try {
      await route(req, res, url)
    } catch (error) {
      const message = (error as Error).message
      if (message === 'tooLarge') return jsonError(res, 413, 'request body exceeds 1 MB')
      jsonError(res, 500, message)
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET'
    if (method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, version: (await import('../package.json', { with: { type: 'json' } })).default.version })
    }
    if (method === 'GET' && url.pathname === '/v1/models') {
      const groups = await listAllModels(loadConfig(cwd, env), env, { fetch: opts.fetch })
      return json(res, 200, groups)
    }
    if (url.pathname === '/v1/sessions' && method === 'POST') {
      const raw = await readBody(req)
      if (typeof raw === 'object') return jsonError(res, 413, 'request body exceeds 1 MB')
      const body = raw ? (JSON.parse(raw) as { cwd?: string; permissionMode?: PermissionMode; model?: string }) : {}
      const s = await openSession(body.cwd ?? cwd, body.permissionMode ?? 'ask', body.model)
      return json(res, 201, { id: s.id, cwd: s.cwd, permissionMode: s.permissionMode })
    }
    if (url.pathname === '/v1/sessions' && method === 'GET') {
      const listCwd = url.searchParams.get('cwd') ?? cwd
      const items = Session.list(home, listCwd).map(({ session, mtime, preview }) => ({
        id: basename(session.file, '.jsonl'), mtime: mtime.toISOString(), preview,
      }))
      return json(res, 200, items)
    }
    const one = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/)
    if (one && method === 'GET') {
      const found = findSessionFile(one[1], url.searchParams.get('cwd') ?? cwd)
      if (!found) return jsonError(res, 404, `unknown session ${one[1]}`)
      return json(res, 200, { id: one[1], cwd: found.cwd, permissionMode: sessions.get(one[1])?.permissionMode ?? 'ask', messages: found.session.load() })
    }
    jsonError(res, 404, `no route ${method} ${url.pathname}`)
  }

  function findSessionFile(id: string, forCwd: string): { session: Session; cwd: string } | undefined {
    const hit = Session.list(home, forCwd).find(({ session }) => basename(session.file, '.jsonl') === id)
    return hit ? { session: hit.session, cwd: forCwd } : undefined
  }

  async function openSession(forCwd: string, permissionMode: PermissionMode, model?: string): Promise<ServedSession> {
    const rt = createRuntime({
      cwd: forCwd,
      args: { ...parseCliArgs([]), allowAll: permissionMode === 'bypassPermissions', model: model ?? undefined } as never,
      env, provider: opts.provider, fetch: opts.fetch,
    })
    return registerSession(rt, forCwd, permissionMode)
  }

  function registerSession(rt: Runtime, forCwd: string, permissionMode: PermissionMode): ServedSession {
    const id = basename(rt.session.file, '.jsonl')
    const s: ServedSession = { id, cwd: forCwd, rt, permissionMode, busy: null, streams: new Set(), pending: new Map() }
    sessions.set(id, s)
    return s
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 8787, host === 'localhost' ? '127.0.0.1' : host, resolve))
  const port = (server.address() as { port: number }).port
  const handle: ServeHandle = {
    port, token,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  return handle
}
```

Catatan implementasi:
- `args` createRuntime bertipe `CliArgs`; cast `as never` HANYA bila field `model` optional tidak cocok — cek `CliArgs` dulu dan samakan tipe tanpa cast bila mungkin (biome akan protes cast longgar).
- Import JSON package: bila `with { type: 'json' }` bermasalah di tsup/NodeNext, ganti baca versi dari `process.env.npm_package_version` fallback konstanta — cek pola yang sudah ada (`rg "version" src/update.ts`).
- `WebSocketServer` di-import sekarang tapi dipakai Task 3 (bila lint noUnusedImports protes, tunda import ke Task 3).

- [ ] **Step 4: Jalankan, pastikan GREEN** — `npx vitest run test/serve.test.ts`.
- [ ] **Step 5: Gates + commit**:

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
git add src/serve.ts test/serve.test.ts
git commit -m "feat: bccli serve — loopback HTTP server with trust fence, bearer auth, session CRUD"
```

---

### Task 3: WS mux + streaming turn (202/409, ready, item, result)

**Files:**
- Modify: `src/serve.ts` (upgrade handler, registry stream, runTurn)
- Test: `test/serve.test.ts` (tambah) — pakai `WebSocket` dari `ws` sebagai client

**Interfaces:**
- Consumes: `ServedSession` Task 2; `parseClientFrame`/`ServerFrame`/`MAX_FRAME_BYTES` Task 1; `AgentEvent` (`src/agent.ts`).
- Produces:
  - upgrade WS di path `/v1/mux` (auth+fence sama; gagal → tulis status line HTTP di socket lalu destroy).
  - `POST /v1/sessions/:id/messages {prompt}` → `202 {turnId}`; busy → `409`.
  - attach-on-demand: id tak dikenal di registry → cari file JSONL (findSessionFile) → `createRuntime` + `rt.resume(session)`; tidak ada → 404.
  - Wire item (value frame `item`): `{type:'ready', sessionId, host:{home, version}}`, `{type:'text',delta}`, `{type:'thinking',delta}`, `{type:'tool_use',tool,target}`, `{type:'tool_result',tool,output,isError}`, `{type:'usage',inputTokens,outputTokens,cachedInputTokens?,cacheWriteTokens?}`, `{type:'result',text,toolCalls,usage,stopReason}`, `{type:'error',message}` — mapping AgentEvent→wire identik semantik `streamTask` sdk (textReplace mengganti akumulasi text tanpa item; stepLimit/budgetExceeded/aborted → stopReason; done/compacted/subagent drop).
  - Stream ditutup (`end`) hanya oleh: client `cancel`, socket close, atau server close — BUKAN oleh selesai-turn.

- [ ] **Step 1: Tulis test gagal** (tambahkan ke `test/serve.test.ts`):

```ts
import WebSocket from 'ws'
import type { ClientFrame, ServerFrame } from '../src/serveProtocol'

export function connectMux(h: ServeHandle): Promise<{ ws: WebSocket; frames: ServerFrame[]; wait: (pred: (f: ServerFrame) => boolean, ms?: number) => Promise<ServerFrame>; send: (f: ClientFrame) => void }> {
  const frames: ServerFrame[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/v1/mux`, { headers: { authorization: `Bearer ${h.token}` } })
  ws.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame))
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  const wait = async (pred: (f: ServerFrame) => boolean, ms = 5000) => {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = frames.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`timeout waiting frame; got ${JSON.stringify(frames)}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return opened.then(() => ({ ws, frames, wait, send: (f) => ws.send(JSON.stringify(f)) }))
}

test('mux: open tanpa token → upgrade ditolak (401)', async () => {
  await withServe(['hi'], async ({ h }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/v1/mux`)
    const code = await new Promise<number>((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)))
    expect(code).toBe(401)
    ws.close()
  })
})

test('turn happy path: 202 turnId → stream ready→text→result; JSONL ter-append; stream tetap terbuka', async () => {
  await withServe(['halo dunia'], async ({ h, base }) => {
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string; cwd: string }
    const mux = await connectMux(h)
    mux.send({ type: 'open', streamId: 'st1', target: `session:${created.id}` })
    const ready = await mux.wait((f) => f.type === 'item' && (f.value as { type: string }).type === 'ready')
    expect(ready).toMatchObject({ streamId: 'st1' })
    const post = await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'hai' })
    expect(post.status).toBe(202)
    expect(await post.json()).toMatchObject({ turnId: expect.any(String) })
    const text = await mux.wait((f) => f.type === 'item' && (f.value as { type: string }).type === 'text')
    expect((text as { value: { delta: string } }).value.delta).toBe('halo dunia')
    const result = await mux.wait((f) => f.type === 'item' && (f.value as { type: string }).type === 'result')
    expect((result as { value: { stopReason: string; text: string } }).value).toMatchObject({ stopReason: 'done', text: 'halo dunia' })
    // belum ada `end` — stream persisten lintas turn
    expect(mux.frames.some((f) => f.type === 'end')).toBe(false)
    // baseline history terisi (persist JSONL)
    const get = (await (await api(base, h.token, `/v1/sessions/${created.id}?cwd=${encodeURIComponent(created.cwd)}`)).json()) as { messages: unknown[] }
    expect(get.messages.length).toBeGreaterThan(0)
    // cancel uplink → end
    mux.send({ type: 'cancel', streamId: 'st1' })
    await mux.wait((f) => f.type === 'end' && f.streamId === 'st1')
    mux.ws.close()
  })
})

test('409 busy: dua POST beruntun pada sesi sama', async () => {
  await withServe(['satu'], async ({ h, base }) => {
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string }
    const first = await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'a' })
    expect(first.status).toBe(202)
    const second = await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'b' })
    // turn pertama masih berjalan (agent.run async) ATAU sudah selesai — keduanya valid;
    // pastikan deterministik: kirim prompt panjang tak mungkin? Tidak — stub sinkron.
    // Stub menyelesaikan turn cepat; maka second bisa 202. Untuk determinisme, tahan stub:
    expect([202, 409]).toContain(second.status)
  })
})

test('409 busy deterministik (stub tertahan gate)', async () => {
  // provider yang menunggu gate sebelum selesai
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const home = mkdtempSync(join(tmpdir(), 'bccli-serve-'))
  const cwd2 = mkdtempSync(join(tmpdir(), 'bccli-serve-cwd-'))
  const h = await startServe({
    port: 0, cwd: cwd2,
    provider: {
      async chat(req) {
        req.onText?.('partial')
        await gate
        return { text: 'partial', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      },
      async listModels() { return ['m'] },
    },
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv,
  })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string }
    expect((await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'a' })).status).toBe(202)
    expect((await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'b' })).status).toBe(409)
  } finally {
    release()
    await h.close()
  }
})

test('attach lintas-restart: serve instance kedua melampirkan sesi dari JSONL (resume)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-serve-'))
  const cwd3 = mkdtempSync(join(tmpdir(), 'bccli-serve-cwd-'))
  const env = { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv
  const h1 = await startServe({ port: 0, cwd: cwd3, provider: scripted(['pertama']), env })
  const base1 = `http://127.0.0.1:${h1.port}`
  const created = (await (await api(base1, h1.token, '/v1/sessions', {})).json()) as { id: string }
  const mux1 = await connectMux(h1)
  mux1.send({ type: 'open', streamId: 's', target: `session:${created.id}` })
  await api(base1, h1.token, `/v1/sessions/${created.id}/messages`, { prompt: 'satu' })
  await mux1.wait((f) => f.type === 'item' && (f.value as { type: string }).type === 'result')
  await h1.close()
  const h2 = await startServe({ port: 0, cwd: cwd3, provider: scripted(['kedua']), env })
  try {
    const base2 = `http://127.0.0.1:${h2.port}`
    const get = (await (await api(base2, h2.token, `/v1/sessions/${created.id}?cwd=${encodeURIComponent(cwd3)}`)).json()) as { messages: { role: string }[] }
    expect(get.messages.length).toBeGreaterThan(0)
    expect((await api(base2, h2.token, `/v1/sessions/${created.id}/messages`, { prompt: 'lanjut' })).status).toBe(202)
    const mux2 = await connectMux(h2)
    mux2.send({ type: 'open', streamId: 's2', target: `session:${created.id}` })
    const result = await mux2.wait((f) => f.type === 'item' && (f.value as { type: string }).type === 'result')
    expect((result as { value: { text: string } }).value.text).toContain('kedua')
    mux2.ws.close()
  } finally {
    await h2.close()
  }
})
```

(Hapus test "409 busy" non-deterministik pertama bila redundan setelah versi gate ada — pertahankan HANYA versi gate.)

- [ ] **Step 2: RED** — `npx vitest run test/serve.test.ts` (test baru gagal: upgrade 401 tak tertangani → connection error; messages → 404).

- [ ] **Step 3: Implementasi** — tambah di `src/serve.ts`:
  - `const wss = new WebSocketServer({ noServer: true })`; di `server.on('upgrade', (req, socket, head) => ...)`: jalankan `trustFence` + path `/v1/mux` + `bearerOk` → gagal: `socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy()`; sukses: `wss.handleUpgrade(...)` → `wss.emit('connection', ws, req)`.
  - Per koneksi: `inboxBytes` tracker; `ws.on('message', (data) => ...)` → bila `data.length > MAX_FRAME_BYTES` kirim `{type:'error',streamId:'',message:'frame exceeds 256 KB'}`; `parseClientFrame` error → `{type:'error',streamId:'',message}`; `open`: streamId sudah ada di registry koneksi → error `duplicate open`; target bukan `session:<id>` atau sesi tak ditemukan (registry ATAU findSessionFile→attach) → error `unknown target`; sukses → daftarkan `streams.set(streamId, {ws, sessionId})`, kirim `ready`, replay pending approvals (Task 4; siapkan loop kosong dulu). `cancel` → hapus stream + kirim `end`. `ws.on('close')` → bersihkan semua stream koneksi.
  - `POST /v1/sessions/:id/messages`: attach-on-demand (findSessionFile → `openSession`-style createRuntime + `rt.resume(found.session)` + registerSession dengan id eksplisit — refactor `registerSession` menerima id override karena `rt.resume` mengganti file); busy → 409; else buat `turnId` + AbortController, set `s.busy`, jadwalkan `void runTurn(s, prompt)` (tanpa await), balas 202 `{turnId}`.
  - `runTurn(s, prompt)`: akumulator `text`/`toolCalls`/`usage`/`stopReason` persis pola `streamTask`; `s.rt.agent.onEvent = (e) => broadcast(s, mapEvent(e))`; `await s.rt.agent.run(prompt, controller.signal)`; finally `s.busy = null`; broadcast item `result`. `mapEvent`: `text`→item text + akumulasi; `textReplace`→`text = e.text` tanpa item; `thinking`→item; `toolStart`→`{type:'tool_use',tool,target}` + catat di map byId; `toolEnd`→`{type:'tool_result',tool,output,isError}` + isi toolCalls; `usage`→item + timpa usage; `stepLimit`/`budgetExceeded`/`aborted`→set stopReason; lainnya drop.
  - `broadcast(s, value)`: untuk tiap streamId di `s.streams` → `ws.send(JSON.stringify({type:'item', streamId, value}))`.

- [ ] **Step 4: GREEN** — `npx vitest run test/serve.test.ts`.
- [ ] **Step 5: Gates + commit**:

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
git add src/serve.ts test/serve.test.ts
git commit -m "feat: serve WS mux — persistent session streams, turn admission (202/409), resume from JSONL"
```

---

### Task 4: Approvals (ask/bypass, POST approvals, fail-closed, replay pending)

**Files:**
- Modify: `src/serve.ts`
- Modify: `docs/superpowers/specs/2026-10-07-serve-design.md` (koreksi field `input`→`target`+`kind` di §6/§8)
- Test: `test/serveApprovals.test.ts` (baru — butuh tool berisiko; stub provider dengan toolCall bash)

**Interfaces:**
- Consumes: `AskPermission`/`PermissionAnswer` (`src/agent.ts`), `ServedSession.pending` Task 2, `broadcast` Task 3.
- Produces:
  - `POST /v1/sessions/:id/approvals {requestId, answer}` → `200 {accepted:true}` / `404` (tidak pending / telat).
  - Wire item `{type:'approval_request', requestId, tool, kind, target, preview?}`.
  - Fail-closed: cancel turn / shutdown server → pending diselesaikan `'no'`. Disconnect WS TIDAK menolak pending (di-replay saat open ulang).
  - `bypassPermissions`: createRuntime `allowAll:true` (Permissions.check langsung allow) + guard `askPermission = async () => 'yes'`.

- [ ] **Step 1: Tulis test gagal** — `test/serveApprovals.test.ts`. Stub provider meminta tool: cek bentuk `Completion.toolCalls` + nama tool bash di `test/agent.test.ts` (`rg "toolCalls" test/agent.test.ts | head`) dan tiru persis satu toolCall `bash` (mis. `{id:'c1', name:'bash', arguments:{command:'echo CANARY_APPROVED'}}`) dengan `text:''`, lalu Completion kedua `reply('selesai')`. Alur:

```ts
// 1. buat sesi permissionMode 'ask' (default), provider scripted [toolCallCompletion, reply('selesai')]
// 2. connectMux + open session stream + POST messages
// 3. wait item approval_request {requestId, tool:'bash'} — echo BELUM boleh jalan
// 4. POST approvals {requestId, answer:'yes'} → 200; wait tool_result isError:false output memuat CANARY_APPROVED; wait result stopReason done
// 5. jawaban telat: POST approvals requestId sama → 404
// 6. fail-closed: sesi baru, turn dengan toolCall, wait approval_request, POST cancel → item result stopReason 'aborted'; POST approvals (requestId tadi) → 404; echo TIDAK pernah dieksekusi (tool_result tidak muncul)
// 7. replay pending: sesi baru, turn toolCall, wait approval_request, TANPA jawab → cancel stream (frame cancel) → open ulang streamId baru → ready diikuti approval_request dengan requestId yang sama → jawab 'yes' → tool_result muncul
// 8. bypassPermissions: POST /v1/sessions {permissionMode:'bypassPermissions'} → tool langsung jalan tanpa approval_request (wait tool_result; assert tidak ada item approval_request di frames)
```

Semua memakai harness `withServe`/`api`/`connectMux` — pindahkan ketiga helper itu ke `test/helpers/serve.ts` (Task 4 step 3) dan import dari kedua file test agar DRY; atau biarkan duplikat bila setup vitest menyulitkan (pilih refactor, lint jscpd repo tidak ada).

- [ ] **Step 2: RED** — `npx vitest run test/serveApprovals.test.ts` → approval_request tak pernah muncul (Agent default `askPermission = async () => 'no'` → tool ditolak langsung).

- [ ] **Step 3: Implementasi** — di `src/serve.ts`:
  - Saat register/attach sesi mode `ask`:
    ```ts
    s.rt.agent.askPermission = (req) =>
      new Promise<PermissionAnswer>((resolve) => {
        const requestId = randomBytes(6).toString('hex')
        s.pending.set(requestId, { resolve })
        broadcast(s, { type: 'approval_request', requestId, tool: req.tool, kind: req.kind, target: req.target, preview: req.preview })
      })
    ```
    mode `bypassPermissions`: `s.rt.agent.askPermission = async () => 'yes'`.
  - Route `POST .../approvals`: parse `{requestId, answer}`; validasi answer ∈ {'yes','no','session','all'} (else 400); `const p = s.pending.get(requestId)`; tidak ada → 404; ada → `s.pending.delete(requestId); p.resolve(answer)` → 200 `{accepted:true}`.
  - Setelah `open` sukses + `ready`: `for (const [requestId] of s.pending) broadcast(...)` — simpan juga `req` (PermissionAsk) di value pending agar replay bisa mengirim ulang payload penuh: `pending: Map<string, {resolve, req: PermissionAsk}>`.
  - `POST .../cancel` (Task 5 route; di Task 4 cukup hook-nya): saat turn abort, selesaikan semua pending `'no'` + clear. Implement sekarang di finally `runTurn`: `for (const [, p] of s.pending) p.resolve('no'); s.pending.clear()`. (Jawaban `no` membuat tool ditolak; agent melanjutkan/mengakhiri turn → result `aborted` karena signal.)
  - `handle.close()`: selesaikan pending `'no'` semua sesi.
  - Koreksi spec §6/§8 (`input`→`target`, tambah `kind`) via tool edit.

- [ ] **Step 4: GREEN** — `npx vitest run test/serve.test.ts test/serveApprovals.test.ts`.
- [ ] **Step 5: Gates + commit**:

```bash
npx tsc --noEmit -p tsconfig.json
npm run lint
git add src/serve.ts test/serveApprovals.test.ts test/serve.test.ts docs/superpowers/specs/2026-10-07-serve-design.md
git commit -m "feat: serve approvals over HTTP — ask/bypass modes, fail-closed, replay pending on reopen"
```

---

### Task 5: Cancel turn, heartbeat, frame guard (oversized/unknown/duplicate)

**Files:**
- Modify: `src/serve.ts` (+ ekstrak `src/serveHeartbeat.ts` bila perlu untuk testability)
- Test: `test/serveMux.test.ts` (baru)

**Interfaces:**
- Consumes: registry stream Task 3, `s.busy.controller` Task 3, pending Task 4.
- Produces:
  - `POST /v1/sessions/:id/cancel` → `200 {cancelled:true}` (404 sesi tak dikenal); abort turn → item `result {stopReason:'aborted'}`; pending approvals → `'no'`.
  - Heartbeat: `ws.ping()` tiap `heartbeatMs` (default 2000; option untuk test); socket tanpa `pong` sebelum tick berikutnya → `ws.terminate()`.
  - Frame guard: oversized (>MAX_FRAME_BYTES) / JSON rusak / type tak dikenal → `{type:'error',streamId:''|<id>,message}` TANPA putus socket; `open` duplikat (streamId sama di koneksi sama) → error; `cancel`/frame untuk streamId tak dikenal → drop diam.

- [ ] **Step 1: Tulis test gagal** — `test/serveMux.test.ts`:
  - **cancel turn**: provider gate seperti test 409 deterministik (chat menunggu promise); POST messages → 202; POST cancel → 200; wait item `result` `stopReason:'aborted'`; busy terkuras → POST messages lagi → 202 (bukan 409).
  - **heartbeat**: ekstrak tracker murni agar bisa di-unit-test —
    ```ts
    // src/serveHeartbeat.ts
    export function createHeartbeat(intervalMs: number, ping: () => void, terminate: () => void): { tick(): void; pong(): void; stop(): void }
    ```
    test dengan fake timers: tick → ping dipanggil; tick lagi tanpa pong → terminate; pong di antara → tidak terminate. Integrasi: startServe heartbeatMs 30, connectMux (ws client otomatis balas pong) → koneksi hidup > 3 interval (wait 120ms, ready masih bisa dikirim).
  - **frame guard**: kirim string 300KB → error frame `frame exceeds`; kirim `{` → error `invalid JSON`; kirim `{"type":"open","streamId":"dup","target":"session:<id>"}` dua kali → yang kedua error `duplicate`; kirim `{"type":"cancel","streamId":"nope"}` → tidak ada frame balik (drop) dan socket tetap hidup (open stream valid setelahnya masih bekerja).

- [ ] **Step 2: RED** — `npx vitest run test/serveMux.test.ts`.
- [ ] **Step 3: Implementasi** — route cancel + `createHeartbeat` (dipanggil per koneksi ws: `setInterval`-free, pakai `setTimeout` berantai di `tick`) + guard di handler message (sebagian sudah ada dari Task 3 — lengkapi sesuai test).
- [ ] **Step 4: GREEN** — `npx vitest run test/serveMux.test.ts test/serve.test.ts test/serveApprovals.test.ts`.
- [ ] **Step 5: Gates + commit**:

```bash
git add src/serve.ts src/serveHeartbeat.ts test/serveMux.test.ts
git commit -m "feat: serve turn cancel, ws heartbeat with terminate, mux frame guards"
```

---

### Task 6: CLI wiring (`bccli serve`), HELP EN+ID, `docs/serve-api.md`

**Files:**
- Modify: `src/args.ts` (union command + SUBCOMMANDS + opsi `--port`/`--host`/`--token` + baris HELP), `src/cli.ts` (dispatch), `src/i18n/id.ts` (key HELP baru + nilai ID)
- Create: `docs/serve-api.md`
- Test: `test/args.test.ts` (tambah case), `test/serveCli.test.ts` (dispatch start/stop via startServe stub — opsional bila cli.ts sulit diunit-test; cukup test args + smoke manual)

**Interfaces:**
- Consumes: `startServe` Task 2.
- Produces: `bccli serve [--port N] [--host H] [--token T]`; `CliArgs.command` termasuk `'serve'`; field baru `port?: number; host?: string; token?: string` (cek nama bentrok di CliArgs dulu — bila `host`/`port` sudah dipakai, prefix `servePort`/`serveHost`/`serveToken`).

- [ ] **Step 1: Test args RED** (tambah di `test/args.test.ts`):

```ts
test('serve: parsing subcommand + flags', () => {
  const a = parseCliArgs(['serve', '--port', '9001', '--token', 'tk'])
  expect(a.command).toBe('serve')
  expect(a.port).toBe(9001)
  expect(a.token).toBe('tk')
})
test('serve: host non-loopback ditolak fail-loud', () => {
  expect(() => parseCliArgs(['serve', '--host', '0.0.0.0'])).toThrow()
})
```

- [ ] **Step 2: Implementasi args**: tambah `'serve'` ke union + `SUBCOMMANDS`; daftarkan opsi parseArgs `port` (type 'string' → Number, NaN → throw ConfigError), `host` (validasi LOOPBACK_BIND saat parse — import dari serveProtocol atau duplikat set kecil), `token` (string). Baris HELP (kolom deskripsi 32, sama seperti `bccli acp`):

```
  bccli serve [--port N]        serve sessions over HTTP+WS for IDEs/bots
```

- [ ] **Step 3: i18n**: salin SELURUH template HELP baru ke key `id.ts` (byte-identik) + nilai ID baris serve:

```
  bccli serve [--port N]        sajikan sesi lewat HTTP+WS untuk IDE/bot
```

Jalankan `npx vitest run test/i18n.test.ts` → GREEN (menjaga key tidak stale).

- [ ] **Step 4: Dispatch cli.ts** (pola `acp`, tempatkan sebelum `createRuntime`):

```ts
if (args.command === 'serve') {
  const { startServe } = await import('./serve')
  const handle = await startServe({ port: args.port, host: args.host, token: args.token, cwd, env: process.env })
  process.stderr.write(`bccli serve ${handle.url} — Authorization: Bearer ${handle.token}\n`)
  await new Promise<void>(() => {})
  return 0
}
```

- [ ] **Step 5: `docs/serve-api.md`**: kontrak lengkap untuk konsumen — tabel endpoint unary (method/path/body/status dari spec §5), protokol mux (§6: tabel frame + contoh transcript open→ready→text→result), auth (§4: 403 vs 401, Bearer), approvals (§8: siklus approval_request→POST→fail-closed), replay/ready discipline, batasan (loopback-only, satu turn per sesi, permissionMode in-memory, tanpa MCP start di v1).
- [ ] **Step 6: Gates + commit**:

```bash
npx vitest run test/args.test.ts test/i18n.test.ts
npx tsc --noEmit -p tsconfig.json
npm run lint
git add src/args.ts src/cli.ts src/i18n/id.ts docs/serve-api.md test/args.test.ts
git commit -m "feat: bccli serve command with HELP (EN+ID) and serve-api contract docs"
```

---

### Task 7: Gates penuh 2×, canary live, AGENTS.md, laporan

**Files:** tidak ada file produk baru (dokumentasi + verifikasi).

- [ ] **Step 1: Gates penuh 2×** — `npx tsc --noEmit -p tsconfig.json`; `npm run lint`; `npm test` (catat jumlah file/test; ulangi sekali, harus stabil); `npm run build`.
- [ ] **Step 2: Canary live** (model nyata, sandbox `BCCLI_HOME`):
  - Setup: `BCCLI_HOME=%TEMP%\bccli-serve-canary`, config minimal provider `gmi` (pola canary Fase 2 — credentials gmi ada di `~/.bccli`; salin `credentials` ke sandbox atau set env yang dibutuhkan provider gmi).
  - Start: `node dist\cli.js serve --port 8799` (build dulu) dengan stderr ditangkap → parse URL+token.
  - Script canary `%TEMP%\opencode\serve-canary.mjs` (node, import `ws` dari repo node_modules): health 200 → create session → mux open → POST prompt "jawab satu kata: OK" → verifikasi item text + result stopReason done → POST cancel tanpa turn → 200 → close.
  - Bukti: simpan output; assert `result.stopReason === 'done'` dan text non-kosong.
- [ ] **Step 3: Bersihkan canary** (hapus `%TEMP%\bccli-serve-canary`, matikan proses serve).
- [ ] **Step 4: AGENTS.md** (`C:\Users\farij\.config\opencode\AGENTS.md`): tambah bullet FASE 3 / serve di section BCCLI (fitur, commit range, gates, canary, gotcha baru bila ada) via tool edit.
- [ ] **Step 5: Laporan akhir** ke user: tabel fitur Task 1–6 + hasil canary + gates + daftar commit + deviasi (koreksi spec `input`→`target`, tanpa MCP start, tanpa seq-journal) + tanya lanjut sub-proyek berikutnya (marketplace) atau tahan.

---

## Self-Review (sudah dijalankan penulis)

1. **Spec coverage**: §3 CLI→Task 6; §4 auth→Task 1+2; §5 unary→Task 2 (+messages Task 3, approvals/cancel Task 4/5); §6 mux→Task 3+5; §7 sesi/concurrency→Task 2+3; §8 approvals→Task 4; §9 testing→Task 1–7; §10 deviasi→Task 7 laporan; §11 deliverables→Task 1–6. Koreksi field `input`→`target` dijadwalkan eksplisit (Task 4).
2. **Placeholder scan**: tidak ada TBD; test 409 non-deterministik ditandai untuk dihapus/diganti versi gate; kode `trustFence` diberi catatan penyederhanaan if-kosong.
3. **Type consistency**: `ServedSession.pending` didefinisikan Task 2 sebagai `Map<string,{resolve}>` lalu DIPERLUAS Task 4 menjadi `{resolve, req}` — Task 2 menuliskan bentuk final `{resolve, req: PermissionAsk}` langsung agar tidak ada drift; `ServeHandle`/`ServeOptions` konsisten Task 2↔6; `broadcast`/`runTurn`/`openSession`/`registerSession`/`findSessionFile` didefinisikan Task 2–3 dan dipakai Task 4–5 dengan nama sama; helper test `withServe`/`api`/`connectMux`/`raw` diekspor dari `test/serve.test.ts` (Task 2–3) dan direfaktor ke `test/helpers/serve.ts` di Task 4.
