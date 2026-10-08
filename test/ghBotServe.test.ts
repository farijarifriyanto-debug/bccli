import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ghBotConfigFrom } from '../src/ghBotDispatch'
import { startGhBot } from '../src/ghBotServe'
import type { GhDeps } from '../src/ghBotRunner'
import { signBody } from '../src/ghBotWebhook'
import type { ChatRequest, Completion, Provider } from '../src/provider'
import { setLanguage } from '../src/i18n'

beforeAll(() => setLanguage('en'))
afterAll(() => setLanguage('id'))

const SECRET = 's3crt-canary-gh'

const commentPayload = (body: string, over: Record<string, unknown> = {}) => ({
  action: 'created',
  issue: { number: 7, title: 'T', body: 'IB' },
  comment: { id: 1, body, user: { login: 'alice', type: 'User' } },
  repository: { full_name: 'acme/demo' },
  ...over,
})

function headersFor(raw: Buffer, delivery: string, secret = SECRET): Record<string, string> {
  return {
    'x-hub-signature-256': signBody(raw, secret),
    'x-hub-delivery': delivery,
    'x-hub-event': 'issue_comment',
    'content-type': 'application/json',
  }
}

async function send(base: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, init)
}

function fakeGh(impl?: (call: number, argv: string[], opts?: { signal?: AbortSignal; stdin?: string }) => Partial<{ code: number; stdout: string; stderr: string }> | undefined) {
  const calls: { argv: string[]; opts?: { signal?: AbortSignal; stdin?: string } }[] = []
  const gh: GhDeps = {
    spawn: async (argv, opts) => {
      const idx = calls.length
      calls.push({ argv, opts })
      const override = impl?.(idx, argv, opts)
      if (override) return { code: override.code ?? 0, stdout: override.stdout ?? '', stderr: override.stderr ?? '' }
      if (argv[0] === 'api') return { code: 0, stdout: '{"id":1}', stderr: '' }
      return { code: 0, stdout: JSON.stringify({ title: 'T', body: 'IB' }), stderr: '' }
    },
  }
  return { gh, calls }
}

function textProvider(sentinel = 'Halo bot'): { provider: Provider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  const provider: Provider = {
    async chat(req: ChatRequest): Promise<Completion> {
      requests.push(req)
      req.onText?.(sentinel)
      return { text: sentinel, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
    },
    async listModels() {
      return ['m']
    },
  }
  return { provider, requests }
}

function toolCallProvider(): { provider: Provider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  const provider: Provider = {
    async chat(req: ChatRequest): Promise<Completion> {
      requests.push(req)
      return {
        text: '',
        toolCalls: [{ id: `c${requests.length}`, name: 'bash', arguments: JSON.stringify({ command: 'echo x' }) }],
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    },
    async listModels() {
      return ['m']
    },
  }
  return { provider, requests }
}

// Home hermetik utk SEMUA test — resolveModel melempar tanpa key (perilaku existing),
// jadi setiap server test memakai BCCLI_HOME tmp + dummy bc-cloud key (pola test/sdk).
const seededEnv = () =>
  ({ BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-ghb-')), BOTCONNECTOR_API_KEY: 'k' }) as NodeJS.ProcessEnv

const cfg = (over: Record<string, unknown> = {}) =>
  ghBotConfigFrom({
    enabled: true,
    repos: ['acme/demo'],
    users: ['alice'],
    secretEnv: 'GH_SECRET_ENV',
    ...over,
  })

test('status table: 202 + dedup; 503 full; 401; 400; 413; 415; 405; corrupt-JSON-ber-signature 400', async () => {
  const { provider, requests } = textProvider()
  const { gh, calls } = fakeGh()
  const h = await startGhBot({
    port: 0,
    config: cfg({ maxQueue: 1 }),
    getSecret: () => SECRET,
    provider,
    gh,
    env: seededEnv(),
    out: () => {},
    err: () => {},
  })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const raw = Buffer.from(JSON.stringify(commentPayload('/bccli hi')))
    const ok = await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-ok'), body: raw })
    expect(ok.status).toBe(202)
    const dup = await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-ok'), body: raw })
    expect(dup.status).toBe(202) // idempoten — kerja tetap 1×
    // 401 signature salah
    const bad = await send(base, '/github', {
      method: 'POST',
      headers: { ...headersFor(raw, 'd-bad'), 'x-hub-signature-256': 'sha256=00' },
      body: raw,
    })
    expect(bad.status).toBe(401)
    // 400 header hilang
    const noHdr = await send(base, '/github', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw })
    expect(noHdr.status).toBe(400)
    // 405 GET
    expect((await send(base, '/github', { method: 'GET' })).status).toBe(405)
    // 415 content-type
    const wrongType = await send(base, '/github', {
      method: 'POST',
      headers: { ...headersFor(raw, 'd-ct'), 'content-type': 'text/plain' },
      body: raw,
    })
    expect(wrongType.status).toBe(415)
    // 413 body > maxBodyBytes (cfg maxBodyBytes kecil)
    const big = Buffer.alloc(300, 0x41)
    const h2 = await startGhBot({
      port: 0,
      config: cfg({ maxBodyBytes: 100 }),
      getSecret: () => SECRET,
      provider,
      gh,
      env: seededEnv(),
      out: () => {},
      err: () => {},
    })
    const bigRes = await send(`http://127.0.0.1:${h2.port}`, '/github', {
      method: 'POST',
      headers: headersFor(big, 'd-big'),
      body: big,
    })
    expect(bigRes.status).toBe(413)
    expect((await send(`http://127.0.0.1:${h2.port}`, '/github', { method: 'GET' })).status).toBe(405) // server tetap hidup
    await h2.close()
    // corrupt JSON dgn signature VALID atas body corrupt → 400 (bukan 401)
    const corrupt = Buffer.from('{corrupt', 'utf8')
    const cor = await send(base, '/github', { method: 'POST', headers: headersFor(corrupt, 'd-cor'), body: corrupt })
    expect(cor.status).toBe(400)
    // tunggu kerja pertama selesai lalu assert dedup: kerja collect hanya 1× utk d-ok
    for (let i = 0; i < 60 && requests.length < 1; i++) await new Promise((r) => setTimeout(r, 25))
    expect(calls.filter((c) => c.argv[0] === 'issue')).toHaveLength(1)
  } finally {
    await h.close()
  }
})

test('off-by-default: disabled → 404; enabled tanpa secret → startGhBot reject (tanpa nilai); non-loopback → reject', async () => {
  const { provider } = textProvider()
  const disabled = await startGhBot({ port: 0, config: cfg({ enabled: false }), getSecret: () => SECRET, provider, out: () => {}, err: () => {} })
  try {
    const raw = Buffer.from(JSON.stringify(commentPayload('/bccli hi')))
    const res = await send(`http://127.0.0.1:${disabled.port}`, '/github', {
      method: 'POST',
      headers: headersFor(raw, 'd-off'),
      body: raw,
    })
    expect(res.status).toBe(404)
  } finally {
    await disabled.close()
  }
  await expect(
    startGhBot({ port: 0, config: cfg(), getSecret: () => undefined, provider, out: () => {}, err: () => {} }),
  ).rejects.toThrow(/GH_SECRET_ENV/)
  await expect(
    startGhBot({ port: 0, host: '0.0.0.0', config: cfg(), getSecret: () => SECRET, provider, out: () => {}, err: () => {} }),
  ).rejects.toThrow(/loopback/)
})

test('rotasi secret: signature lama → 401; secret baru → 202 (tanpa restart)', async () => {
  let secret = SECRET
  const { provider } = textProvider()
  const h = await startGhBot({ port: 0, config: cfg(), getSecret: () => secret, provider, env: seededEnv(), out: () => {}, err: () => {} })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const raw = Buffer.from(JSON.stringify(commentPayload('/bccli rotasi')))
    const before = await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-rot1', SECRET), body: raw })
    expect(before.status).toBe(202)
    secret = 'rotated-secret-gh'
    const stale = await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-rot2', SECRET), body: raw })
    expect(stale.status).toBe(401) // secret lama sudah tak berlaku
    const fresh = await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-rot3', 'rotated-secret-gh'), body: raw })
    expect(fresh.status).toBe(202) // accessor per-request — tanpa restart
  } finally {
    await h.close()
  }
})

test('glue nyata: tools=0 selama run, system=ghSystemPrompt, provider terpakai, post 1× (--input -), secret tak bocor', async () => {
  const { provider, requests } = textProvider('Halo dari agent')
  const { gh, calls } = fakeGh()
  const logs: string[] = []
  const h = await startGhBot({ port: 0, config: cfg(), getSecret: () => SECRET, provider, gh, env: seededEnv(), out: (s) => logs.push(s ?? ''), err: (s) => logs.push(s ?? '') })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const raw = Buffer.from(JSON.stringify(commentPayload('/bccli sapa')))
    const res = await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-glue'), body: raw })
    expect(res.status).toBe(202)
    for (let i = 0; i < 100 && requests.length < 1; i++) await new Promise((r) => setTimeout(r, 25))
    // tunggu post juga
    let posted = 0
    for (let i = 0; i < 100 && posted === 0; i++) {
      posted = calls.filter((c) => c.argv[0] === 'api').length
      if (posted === 0) await new Promise((r) => setTimeout(r, 25))
    }
    expect(requests.length).toBeGreaterThanOrEqual(1)
    expect((requests[0].tools ?? []).length).toBe(0) // nol tool selama run (revisi #2)
    const first = JSON.stringify(requests[0].messages)
    expect(first).toContain('exactly one comment') // system prompt via API agent
    expect(first).toContain('untrusted') // konteks berblok
    const post = calls.find((c) => c.argv[0] === 'api')
    expect(post).toBeDefined()
    expect(post?.argv).toEqual(['api', '--method', 'POST', '--input', '-', 'repos/acme/demo/issues/7/comments'])
    const sent = JSON.parse(String(post?.opts?.stdin)) as { body: string }
    expect(sent.body).toBe('Halo dari agent') // draft = hasil agent
    const all = [...logs, ...(await res.text().catch(() => ''))]
    expect(all.join('\n')).not.toContain(SECRET) // secret tak pernah di output
    expect(await res.text().catch(() => '')).not.toContain(SECRET)
  } finally {
    await h.close()
  }
})

test('timeout deadline e2e: gh collect tertahan → signal abort → job gagal, post 0×', async () => {
  const { provider } = textProvider()
  const { gh, calls } = fakeGh((idx, _argv, opts) => {
    if (idx === 0) {
      // collect: tertahan sampai signal abort (meniru spawn asli yang di-kill)
      return new Promise((resolve) => {
        opts?.signal?.addEventListener('abort', () => resolve({ code: 1, stderr: 'aborted' }))
      }) as never
    }
    return undefined
  })
  const h = await startGhBot({ port: 0, config: cfg({ timeoutMs: 40 }), getSecret: () => SECRET, provider, gh, env: seededEnv(), out: () => {}, err: () => {} })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const raw = Buffer.from(JSON.stringify(commentPayload('/bccli timeout')))
    const res = await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-to'), body: raw })
    expect(res.status).toBe(202)
    await new Promise((r) => setTimeout(r, 200)) // lewati deadline 40ms
    expect(calls.filter((c) => c.argv[0] === 'api')).toHaveLength(0) // TANPA post
  } finally {
    await h.close()
  }
})

test('komentor Unicode besar e2e: konteks terpotong byte-safe dalam prompt provider', async () => {
  const big = '😀漢字'.repeat(3000)
  const { provider, requests } = textProvider()
  const { gh } = fakeGh((_idx, argv) => (argv[1] === 'view' ? { stdout: JSON.stringify({ title: 'T', body: big }) } : undefined))
  const h = await startGhBot({ port: 0, config: cfg(), getSecret: () => SECRET, provider, gh, env: seededEnv(), out: () => {}, err: () => {} })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const raw = Buffer.from(JSON.stringify(commentPayload(`/bccli ${big}`)))
    const res = await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-uni'), body: raw })
    expect(res.status).toBe(202)
    for (let i = 0; i < 200 && requests.length < 1; i++) await new Promise((r) => setTimeout(r, 25))
    expect(requests.length).toBeGreaterThanOrEqual(1)
    const payload = JSON.stringify(requests[0].messages)
    expect(payload).toContain('truncated') // cap byte aktif
    expect(payload.includes('�')).toBe(false) // tak ada char rusak
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(200_000) // batas kerangka
  } finally {
    await h.close()
  }
})

test('factory stepLimit: provider selalu toolCall → berhenti + post 0× (terminal stepLimit)', async () => {
  const { provider, requests } = toolCallProvider()
  const { gh, calls } = fakeGh()
  const h = await startGhBot({ port: 0, config: cfg({ stepLimit: 2 }), getSecret: () => SECRET, provider, gh, env: seededEnv(), out: () => {}, err: () => {} })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const raw = Buffer.from(JSON.stringify(commentPayload('/bccli tool-loop')))
    const res = await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-step'), body: raw })
    expect(res.status).toBe(202)
    for (let i = 0; i < 200 && calls.filter((c) => c.argv[0] === 'api').length === 0 && requests.length < 10; i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    await new Promise((r) => setTimeout(r, 200))
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.length).toBeLessThanOrEqual(5) // stepLimit membatasi langkah (revisi #2)
    expect(calls.filter((c) => c.argv[0] === 'api')).toHaveLength(0) // stepLimit ≠ post
    expect((requests[0].tools ?? []).length).toBe(0)
  } finally {
    await h.close()
  }
})

test('env diteruskan: BCCLI_HOME tmp → sesi tercipta di home tmp', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-ghb-'))
  const { provider } = textProvider()
  const { gh } = fakeGh()
  const errLines: string[] = []
  const h = await startGhBot({
    port: 0,
    config: cfg(),
    getSecret: () => SECRET,
    provider,
    gh,
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv,
    out: () => {},
    err: (s) => errLines.push(s ?? ''),
  })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const raw = Buffer.from(JSON.stringify(commentPayload('/bccli env')))
    expect((await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-env'), body: raw })).status).toBe(202)
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(home, 'sessions'))) break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(errLines.join('\n')).toBe('') // tidak ada error job tersembunyi
    expect(existsSync(join(home, 'sessions'))).toBe(true) // runtime memakai env, bukan snapshot
  } finally {
    await h.close()
  }
})

test('fetch injectable: spy terpakai ke server HTTP lokal palsu (revisi #3)', async () => {
  // server chat lokal
  const local = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: 'lokal-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    })
  })
  await new Promise<void>((r) => local.listen(0, '127.0.0.1', r))
  const localPort = (local.address() as AddressInfo).port

  const home = mkdtempSync(join(tmpdir(), 'bccli-ghb-'))
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      model: 'fake/test-model',
      providers: { fake: { baseURL: `http://127.0.0.1:${localPort}/v1`, apiKeyEnv: 'FAKE_KEY' } },
    }),
  )
  const realFetch = globalThis.fetch
  const spyCalls: string[] = []
  const spyFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    spyCalls.push(String(input))
    return realFetch(input, init)
  }) as typeof fetch
  const { gh } = fakeGh()
  const dbgErr: string[] = []
  const h = await startGhBot({
    port: 0,
    config: cfg(),
    getSecret: () => SECRET,
    fetch: spyFetch,
    env: { BCCLI_HOME: home, FAKE_KEY: 'k' } as NodeJS.ProcessEnv,
    gh,
    out: () => {},
    err: (s) => dbgErr.push(s ?? ''),
  })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const raw = Buffer.from(JSON.stringify(commentPayload('/bccli fetch')))
    expect((await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-fet'), body: raw })).status).toBe(202)
    for (let i = 0; i < 200 && spyCalls.length < 1 && dbgErr.length === 0; i++) await new Promise((r) => setTimeout(r, 25))
    if (dbgErr.length) console.error('FETCH-TEST ERR:', dbgErr)
    expect(spyCalls.length).toBeGreaterThanOrEqual(1) // o.fetch BENAR diteruskan ke createRuntime
    expect(spyCalls.join('\n')).toContain(`127.0.0.1:${localPort}`) // menuju server lokal palsu
  } finally {
    await h.close()
    await new Promise<void>((r) => local.close(() => r()))
  }
})

test('koreksi #1: post hard-timeout → reason termination-unconfirmed → close UNCONFIRMED=1 + bukan LRU (redelivery jalan)', async () => {
  const marker = '<child did not close after termination>'
  const { provider } = textProvider()
  const { gh, calls } = fakeGh((idx, argv) => {
    if (idx === 1 && argv[0] === 'api') return { code: 1, stderr: `boom\n${marker}` } // post hard-timeout
    return undefined
  })
  const errLines: string[] = []
  const h = await startGhBot({ port: 0, config: cfg(), getSecret: () => SECRET, provider, gh, env: seededEnv(), out: () => {}, err: (s) => errLines.push(s ?? '') })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const raw = Buffer.from(JSON.stringify(commentPayload('/bccli hardpost')))
    expect((await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-hp1'), body: raw })).status).toBe(202)
    for (let i = 0; i < 200 && calls.filter((c) => c.argv[0] === 'api').length === 0; i++) await new Promise((r) => setTimeout(r, 25))
    expect(calls.filter((c) => c.argv[0] === 'api')).toHaveLength(1) // post dicoba & gagal
    // bukti TIDAK masuk completed LRU: delivery sama diterima lagi → collect dijalankan ULANG
    expect((await send(base, '/github', { method: 'POST', headers: headersFor(raw, 'd-hp1'), body: raw })).status).toBe(202)
    for (let i = 0; i < 100 && calls.filter((c) => c.argv[0] === 'issue').length < 2; i++) await new Promise((r) => setTimeout(r, 25))
    expect(calls.filter((c) => c.argv[0] === 'issue').length).toBeGreaterThanOrEqual(2) // re-admission = belum di LRU
    const summary = await h.close()
    expect(summary.terminationUnconfirmed).toBeGreaterThanOrEqual(1)
    expect(summary.terminationConfirmed).toBe(0)
    expect(errLines.join('\n')).toMatch(/UNCONFIRMED \d+ .*child may still be running/)
  } catch (e) {
    await h.close()
    throw e
  }
})

