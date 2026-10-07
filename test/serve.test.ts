import { expect, test } from 'vitest'
import { startServe } from '../src/serve'
import { api, raw, withServe } from './helpers/serve'

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
