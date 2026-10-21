import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import WebSocket from 'ws'
import type { Provider, ToolCall } from '../src/provider'
import { type ServeHandle, serveBanner, startServe } from '../src/serve'
import type { ServerFrame } from '../src/serveProtocol'
import { api, connectMux, isItem, raw, scripted, withServe } from './helpers/serve'

test('banner serve: token dari user tidak ikut dicetak, token acak dicetak', () => {
  const handle = { url: 'http://127.0.0.1:5555', token: 'secret-token' }
  // --token / BCCLI_SERVE_TOKEN: user sudah punya nilainya, jangan bocorkan ke log.
  expect(serveBanner(handle, { token: 'secret-token', env: {} })).toBe('bccli serve http://127.0.0.1:5555\n')
  expect(serveBanner(handle, { env: { BCCLI_SERVE_TOKEN: 'secret-token' } })).toBe('bccli serve http://127.0.0.1:5555\n')
  // Token yang dibuat BCCLI sendiri harus tampil supaya user bisa menyambung.
  expect(serveBanner(handle, { env: {} })).toBe('bccli serve http://127.0.0.1:5555 — Authorization: Bearer secret-token\n')
})

test('health tanpa token → 200 {ok,version}; /v1/models tanpa token → 401', async () => {
  await withServe(['hi'], async ({ base }) => {
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

test('GET session id tak dikenal → 404', async () => {
  await withServe(['hi'], async ({ h, base }) => {
    const res = await api(base, h.token, '/v1/sessions/tidak-ada')
    expect(res.status).toBe(404)
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

test('--host non-loopback ditolak startServe', async () => {
  await expect(startServe({ port: 0, host: '0.0.0.0' })).rejects.toThrow(/loopback/)
})

test('mux: open tanpa token → upgrade ditolak (401)', async () => {
  await withServe(['hi'], async ({ h }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/v1/mux`)
    ws.on('error', () => {}) // upgrade ditolak — error event Expected
    const code = await new Promise<number>((resolve) =>
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    )
    expect(code).toBe(401)
    ws.terminate()
  })
})

test('turn happy path: 202 turnId → ready→text→result; JSONL ter-append; stream tetap terbuka; cancel→end', async () => {
  await withServe(['halo dunia'], async ({ h, base }) => {
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string; cwd: string }
    const mux = await connectMux(h)
    mux.send({ type: 'open', streamId: 'st1', target: `session:${created.id}` })
    const ready = await mux.wait(isItem('ready'))
    expect(ready.streamId).toBe('st1')
    const post = await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'hai' })
    expect(post.status).toBe(202)
    expect(await post.json()).toMatchObject({ turnId: expect.any(String) })
    const text = await mux.wait(isItem('text'))
    expect((text as { value: { delta: string } }).value.delta).toBe('halo dunia')
    const result = await mux.wait(isItem('result'))
    expect((result as { value: { stopReason: string; text: string } }).value).toMatchObject({
      stopReason: 'done',
      text: 'halo dunia',
    })
    // belum ada `end` — stream persisten lintas turn
    expect(mux.frames.some((f) => f.type === 'end')).toBe(false)
    // baseline history terisi (persist JSONL)
    const get = (await (await api(base, h.token, `/v1/sessions/${created.id}?cwd=${encodeURIComponent(created.cwd)}`)).json()) as {
      messages: unknown[]
    }
    expect(get.messages.length).toBeGreaterThan(0)
    mux.send({ type: 'cancel', streamId: 'st1' })
    await mux.wait((f) => f.type === 'end' && f.streamId === 'st1')
    mux.ws.close()
  })
})

test('messages: prompt hilang → 400; sesi tak dikenal → 404', async () => {
  await withServe(['hi'], async ({ h, base }) => {
    expect((await api(base, h.token, '/v1/sessions/x/messages', {})).status).toBe(404)
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string }
    expect((await api(base, h.token, `/v1/sessions/${created.id}/messages`, {})).status).toBe(400)
  })
})

test('409 busy deterministik (stub tertahan gate)', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const home = mkdtempSync(join(tmpdir(), 'bccli-serve-'))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-serve-cwd-'))
  const h = await startServe({
    port: 0,
    cwd,
    provider: {
      async chat(req) {
        req.onText?.('partial')
        await gate
        return { text: 'partial', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      },
      async listModels() {
        return ['m']
      },
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
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-serve-cwd-'))
  const env = { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv
  const h1 = await startServe({ port: 0, cwd, provider: scripted(['pertama']), env })
  const base1 = `http://127.0.0.1:${h1.port}`
  const created = (await (await api(base1, h1.token, '/v1/sessions', {})).json()) as { id: string }
  const mux1 = await connectMux(h1)
  mux1.send({ type: 'open', streamId: 's', target: `session:${created.id}` })
  await mux1.wait(isItem('ready'))
  await api(base1, h1.token, `/v1/sessions/${created.id}/messages`, { prompt: 'satu' })
  await mux1.wait(isItem('result'))
  mux1.ws.close()
  await h1.close()
  const h2 = await startServe({ port: 0, cwd, provider: scripted(['kedua']), env })
  try {
    const base2 = `http://127.0.0.1:${h2.port}`
    const get = (await (await api(base2, h2.token, `/v1/sessions/${created.id}?cwd=${encodeURIComponent(cwd)}`)).json()) as {
      messages: { role: string }[]
    }
    expect(get.messages.length).toBeGreaterThan(0)
    const mux2 = await connectMux(h2)
    mux2.send({ type: 'open', streamId: 's2', target: `session:${created.id}` })
    await mux2.wait(isItem('ready'))
    expect((await api(base2, h2.token, `/v1/sessions/${created.id}/messages`, { prompt: 'lanjut' })).status).toBe(202)
    const result = await mux2.wait(isItem('result'))
    expect((result as { value: { text: string } }).value.text).toContain('kedua')
    // history lama termuat (resume): pesan user 'satu' ada di baseline
    const get2 = (await (await api(base2, h2.token, `/v1/sessions/${created.id}?cwd=${encodeURIComponent(cwd)}`)).json()) as {
      messages: { role: string; content: unknown }[]
    }
    expect(JSON.stringify(get2.messages)).toContain('satu')
    mux2.ws.close()
  } finally {
    await h2.close()
  }
})

test('attach lintas-restart: turn lanjutan memakai model sesi dari JSONL, bukan config.model host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-serve-'))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-serve-cwd-'))
  const env = { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv
  writeFileSync(join(home, 'config.json'), JSON.stringify({ model: 'bc-cloud/model-a' }))
  const h1 = await startServe({ port: 0, cwd, provider: scripted(['pertama']), env })
  const base1 = `http://127.0.0.1:${h1.port}`
  const created = (await (await api(base1, h1.token, '/v1/sessions', {})).json()) as { id: string }
  const mux1 = await connectMux(h1)
  mux1.send({ type: 'open', streamId: 's', target: `session:${created.id}` })
  await mux1.wait(isItem('ready'))
  await api(base1, h1.token, `/v1/sessions/${created.id}/messages`, { prompt: 'satu' })
  await mux1.wait(isItem('result'))
  mux1.ws.close()
  await h1.close()

  // Host serve berubah model; sesi yang di-attach harus tetap memakai model yang tercatat di lognya.
  writeFileSync(join(home, 'config.json'), JSON.stringify({ model: 'bc-cloud/model-b' }))
  const h2 = await startServe({ port: 0, cwd, provider: scripted(['kedua']), env })
  try {
    const base2 = `http://127.0.0.1:${h2.port}`
    const mux2 = await connectMux(h2)
    mux2.send({ type: 'open', streamId: 's2', target: `session:${created.id}` })
    await mux2.wait(isItem('ready'))
    expect((await api(base2, h2.token, `/v1/sessions/${created.id}/messages`, { prompt: 'lanjut' })).status).toBe(202)
    const result = await mux2.wait(isItem('result'))
    expect((result as { value: { text: string } }).value.text).toContain('kedua')
    mux2.ws.close()

    const usageModels = (): (string | undefined)[] => {
      const dir = readdirSync(join(home, 'sessions'))[0]
      return readFileSync(join(home, 'sessions', dir, `${created.id}.jsonl`), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { t: string; model?: string })
        .filter((record) => record.t === 'usage')
        .map((record) => record.model)
    }
    let models = usageModels()
    for (let i = 0; i < 100 && models.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 20))
      models = usageModels()
    }
    expect(models.length).toBeGreaterThanOrEqual(2)
    expect(models.at(-1)).toBe('bc-cloud/model-a')
  } finally {
    await h2.close()
  }
})

// ---- display forwarding di tool_result (Plan A: docs/superpowers/plans/2026-10-21-serve-display-forwarding.md) ----

const toolCall = (name: string, args: unknown, id = `tc-${Math.random().toString(36).slice(2)}`): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
})

// Provider stub: tiap giliran mengeluarkan satu batch tool calls, lalu reply teks final.
function toolsProvider(script: ToolCall[][]): Provider {
  let n = 0
  return {
    async chat(req) {
      const calls = script[n++]
      if (calls) return { text: '', toolCalls: calls, usage: { inputTokens: 1, outputTokens: 1 } }
      req.onText?.('done')
      return { text: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
    },
    async listModels() {
      return ['serve-model']
    },
  }
}

// withServe menyembunyikan cwd; test display butuh file nyata di disk → scaffold sendiri.
async function withServeCwd(
  files: Record<string, string>,
  provider: Provider,
  fn: (ctx: { h: ServeHandle; base: string; cwd: string }) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'bccli-display-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-display-cwd-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content)
  const h = await startServe({
    port: 0,
    cwd,
    provider,
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv,
  })
  try {
    await fn({ h, base: `http://127.0.0.1:${h.port}`, cwd })
  } finally {
    await h.close()
  }
}

const toolResultOf = (tool: string) => (f: ServerFrame): boolean => {
  if (!isItem('tool_result')(f)) return false
  const v = (f as unknown as { value: { tool?: string } }).value
  return v.tool === tool
}

const itemValue = (f: unknown): Record<string, unknown> => (f as { value: Record<string, unknown> }).value

async function openTurn(h: ServeHandle, base: string): Promise<{ mux: Awaited<ReturnType<typeof connectMux>>; id: string }> {
  const created = (await (
    await api(base, h.token, '/v1/sessions', { permissionMode: 'bypassPermissions' })
  ).json()) as { id: string }
  const mux = await connectMux(h)
  mux.send({ type: 'open', streamId: 'st1', target: `session:${created.id}` })
  await mux.wait(isItem('ready'))
  return { mux, id: created.id }
}

test('tool_result meneruskan display: diff edit sampai ke 2 klien mux, ringkasan result.toolCalls tetap tanpa display', async () => {
  await withServeCwd({ 'a.txt': 'x\n' }, toolsProvider([
    [toolCall('read', { path: 'a.txt' })],
    [toolCall('edit', { path: 'a.txt', old_string: 'x', new_string: 'y' })],
  ]), async ({ h, base }) => {
    const { mux, id } = await openTurn(h, base)
    const mux2 = await connectMux(h)
    mux2.send({ type: 'open', streamId: 'st1', target: `session:${id}` })
    await mux2.wait(isItem('ready'))
    const post = await api(base, h.token, `/v1/sessions/${id}/messages`, { prompt: 'go' })
    expect(post.status).toBe(202)

    const hit = await mux.wait(toolResultOf('edit'))
    const item = itemValue(hit)
    expect(typeof item.display).toBe('string')
    // formatDiff (src/diff.ts): "    1 - x" / "    1 + y"
    expect(item.display as string).toMatch(/- x/)
    expect(item.display as string).toMatch(/\+ y/)

    const hit2 = await mux2.wait(toolResultOf('edit'))
    expect(itemValue(hit2).display).toBe(item.display)

    const result = await mux.wait(isItem('result'))
    const calls = itemValue(result).toolCalls as Record<string, unknown>[]
    expect(calls.length).toBe(2)
    expect(Object.keys(calls[1]!).sort()).toEqual(['isError', 'name', 'output', 'target'])
    mux.ws.close()
    mux2.ws.close()
  })
})

test('tool_result tanpa display dari tool (bash): key display tidak muncul sama sekali', async () => {
  await withServeCwd({}, toolsProvider([[toolCall('bash', { command: 'echo hi' })]]), async ({ h, base }) => {
    const { mux, id } = await openTurn(h, base)
    await api(base, h.token, `/v1/sessions/${id}/messages`, { prompt: 'go' })
    const hit = await mux.wait(toolResultOf('bash'))
    expect('display' in itemValue(hit)).toBe(false)
    mux.ws.close()
  })
})

test('display oversized dipotong di cap 100k karakter + marker [truncated]', async () => {
  const big = 'x'.repeat(150_000)
  await withServeCwd({ 'a.txt': big }, toolsProvider([
    [toolCall('read', { path: 'a.txt' })],
    [toolCall('edit', { path: 'a.txt', old_string: big, new_string: 'short' })],
  ]), async ({ h, base }) => {
    const { mux, id } = await openTurn(h, base)
    await api(base, h.token, `/v1/sessions/${id}/messages`, { prompt: 'go' })
    const hit = await mux.wait(toolResultOf('edit'))
    const display = itemValue(hit).display as string
    expect(typeof display).toBe('string')
    expect(display.endsWith('\n[truncated]')).toBe(true)
    expect(display.length).toBeLessThanOrEqual(100_000 + '\n[truncated]'.length)
    mux.ws.close()
  })
})
