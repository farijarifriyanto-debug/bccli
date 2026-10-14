import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { type CliArgs, parseCliArgs } from '../src/args'
import { globalConfigPath, readCredentials, saveCredential } from '../src/config'
import { type LoginDeps, runLogin } from '../src/login'
import { setLanguage } from '../src/i18n'
import {
  ABORT,
  buildAuthUrl,
  classifyExchange403,
  exchangeAuthCode,
  OPENROUTER_AUTH_URL,
  OPENROUTER_EXCHANGE_URL,
  pkcePair,
  redact,
  runOauthLogin,
  runOauthLogout,
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

// ===== Task 2: orkestrasi login/logout =====

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

test('kontrak #1: env OPENROUTER_API_KEY ter-set → sukses DENGAN catatan (credential tersimpan diutamakan, env cadangan)', async () => {
  const h = loginHarness()
  const env = { ...h.deps.env, OPENROUTER_API_KEY: 'env-key-x' }
  expect(await runOauthLogin({ ...h.deps, env })).toBe(0)
  expect(h.all()).toContain('takes priority')
  expect(h.all()).toContain('OPENROUTER_API_KEY')
})

test('kontrak #1 resolusi: credential tersimpan menang atas env (resolveModel); env hanya cadangan', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-oauth-'))
  const env = { BCCLI_HOME: home } as NodeJS.ProcessEnv
  saveCredential('openrouter', 'stored-key', env)
  writeFileSync(globalConfigPath(env), JSON.stringify({ providers: { openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' } } }))
  const { loadConfig, resolveModel } = await import('../src/config')
  const cfg = loadConfig(process.cwd(), env)
  expect(resolveModel(cfg, 'openrouter/x', { ...env, OPENROUTER_API_KEY: 'env-key' }).apiKey).toBe('stored-key')
  expect(resolveModel(cfg, 'openrouter/x', env).apiKey).toBe('stored-key')
  // tanpa credential tersimpan, env dipakai sebagai cadangan
  const empty = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-oauth-')) } as NodeJS.ProcessEnv
  writeFileSync(globalConfigPath(empty), JSON.stringify({ providers: { openrouter: { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' } } }))
  const cfg2 = loadConfig(process.cwd(), empty)
  expect(resolveModel(cfg2, 'openrouter/x', { ...empty, OPENROUTER_API_KEY: 'env-key' }).apiKey).toBe('env-key')
})

test('kontrak #2 timeout: pesan timeout, credential lama utuh', async () => {
  const h = loginHarness({
    // Stub bereaksi terhadap signal sungguhan (timeoutMs kecil) — klasifikasi asal-signal.
    fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'TimeoutError'
          reject(e)
        })
      })
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
    fetch: (async () => {
      called++
      return new Response('{}')
    }) as typeof fetch,
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

test('kontrak #3: 403 expired → pesan expired; 403 invalid → pesan rejected TANPA kata expired; body kosong → rejected', async () => {
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

test('kontrak #4: exchange sukses tapi saveCredential gagal → remote-created + belum lokal + dashboard', async () => {
  const h = loginHarness({
    saveCredential: () => {
      throw new Error('EACCES denied')
    },
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
  let capturedVerifier = ''
  const h = loginHarness({
    readLine: async () => 'CODE-WITH-SECRET',
    fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      // Verifier AKTUAL dari request (pkcePair internal) disisipkan ke pesan error
      const { code_verifier } = JSON.parse(String(init?.body)) as { code_verifier: string }
      capturedVerifier = code_verifier
      throw new TypeError(`failed sending CODE-WITH-SECRET and ${code_verifier}`)
    }) as typeof fetch,
  })
  expect(await runOauthLogin(h.deps)).toBe(1)
  expect(h.all()).toContain('Could not reach OpenRouter')
  expect(h.all()).toContain('***')
  expect(h.all()).not.toContain('CODE-WITH-SECRET')
  expect(capturedVerifier).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(h.all()).not.toContain(capturedVerifier)
})

test('non-TTY tanpa --key: exit 1, instruksi --key, open TIDAK dipanggil', async () => {
  let opened = 0
  const h = loginHarness({
    isTTY: false,
    open: () => {
      opened++
    },
  })
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

/** Header 200 diterima langsung; res.json() tertahan sampai signal abort (celah #2). */
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

// ===== Task 3: dispatch runLogin (LoginDeps nyata, tanpa cast liar) =====

function dispatchHarness(over: Partial<LoginDeps> = {}) {
  const calls = { open: 0, readLine: 0, save: 0, remove: 0, legacy: [] as string[] }
  const errLines: string[] = []
  const deps: LoginDeps = {
    out: () => {},
    err: (s) => errLines.push(s),
    env: {},
    isTTY: true,
    open: () => {
      calls.open++
    },
    readLine: async () => {
      calls.readLine++
      return 'CODE'
    },
    saveCredential: () => {
      calls.save++
    },
    removeCredential: () => {
      calls.remove++
      return true
    },
    fetch: (async () => new Response('{"key":"k"}', { status: 200 })) as typeof fetch,
    legacyAdd: async (id) => {
      calls.legacy.push(id)
      return 0
    },
    ...over,
  }
  const withArgs = (args: Partial<CliArgs>): CliArgs => ({ ...parseCliArgs(['login', 'openrouter']), ...args })
  return {
    calls,
    errLines,
    deps,
    runConflict: () => runLogin('openrouter', '.', withArgs({ key: true, logout: true }), deps),
    runLogout: () => runLogin('openrouter', '.', withArgs({ logout: true }), deps),
    runKey: () => runLogin('openrouter', '.', withArgs({ key: true }), deps),
    runDefault: () => runLogin('openrouter', '.', withArgs({}), deps),
  }
}

test('kontrak #6: --key --logout → exit 1, SEMUA spy nol panggilan (urutan guard paling awal)', async () => {
  const h = dispatchHarness()
  expect(await h.runConflict()).toBe(1)
  expect(h.calls).toEqual({ open: 0, readLine: 0, save: 0, remove: 0, legacy: [] })
  expect(h.errLines.join('\n')).toContain('not both')
})

test('rev #5: logout provider LAIN ditolak — removeCredential TIDAK dipanggil, pesan arahan provider remove', async () => {
  const h = dispatchHarness()
  const r = await runLogin('groq', '.', { ...parseCliArgs(['login', 'groq']), logout: true, key: false }, h.deps)
  expect(r).toBe(1)
  expect(h.calls.remove).toBe(0) // tidak pernah diam-diam menghapus credential yang salah
  expect(h.calls.legacy).toEqual([])
  expect(h.errLines.join('\n')).toContain('Logout is not supported for groq')
  expect(h.errLines.join('\n')).toContain('bccli provider remove groq')
})

test('dispatch: openrouter --logout → removeCredential; --key → legacy (jalur lama); default openrouter → OAuth; groq default → legacy', async () => {
  const a = dispatchHarness()
  expect(await a.runLogout()).toBe(0)
  expect(a.calls.remove).toBe(1)
  expect(a.calls.open).toBe(0)

  const b = dispatchHarness()
  expect(await b.runKey()).toBe(0)
  expect(b.calls.legacy).toEqual(['openrouter'])
  expect(b.calls.open).toBe(0)

  const c = dispatchHarness() // default openrouter → jalur OAuth (open terpanggil, save terpanggil)
  expect(await c.runDefault()).toBe(0)
  expect(c.calls.open).toBe(1)
  expect(c.calls.save).toBe(1)

  const d = dispatchHarness()
  const r = await runLogin('groq', '.', parseCliArgs(['login', 'groq']), d.deps)
  expect(r).toBe(0)
  expect(d.calls.legacy).toEqual(['groq'])
  expect(d.calls.open).toBe(0)
})
