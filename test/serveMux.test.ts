import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHeartbeat } from '../src/serveHeartbeat'
import { api, connectMux, isItem, withServe } from './helpers/serve'

describe('createHeartbeat (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('start → ping pertama; pong → tick berikutnya ping lagi tanpa terminate', () => {
    const ping = vi.fn()
    const terminate = vi.fn()
    const hb = createHeartbeat(1000, ping, terminate)
    hb.start()
    expect(ping).toHaveBeenCalledTimes(1)
    hb.pong()
    vi.advanceTimersByTime(1000)
    expect(ping).toHaveBeenCalledTimes(2)
    expect(terminate).not.toHaveBeenCalled()
  })

  test('tanpa pong sebelum tick berikutnya → terminate', () => {
    const ping = vi.fn()
    const terminate = vi.fn()
    const hb = createHeartbeat(1000, ping, terminate)
    hb.start()
    vi.advanceTimersByTime(1000) // belum ada pong sejak ping pertama
    expect(terminate).toHaveBeenCalledTimes(1)
    expect(ping).toHaveBeenCalledTimes(1)
  })

  test('stop → tidak ada ping/terminate lagi', () => {
    const ping = vi.fn()
    const terminate = vi.fn()
    const hb = createHeartbeat(1000, ping, terminate)
    hb.start()
    hb.stop()
    vi.advanceTimersByTime(5000)
    expect(ping).toHaveBeenCalledTimes(1)
    expect(terminate).not.toHaveBeenCalled()
  })
})

test('heartbeat integrasi: koneksi ws auto-pong bertahan >3 interval (heartbeatMs 30)', async () => {
  const { startServe } = await import('../src/serve')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const h = await startServe({
    port: 0,
    heartbeatMs: 30,
    cwd: mkdtempSync(join(tmpdir(), 'bccli-serve-')),
    env: { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-serve-')), BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv,
  })
  try {
    const mux = await connectMux(h)
    await new Promise((r) => setTimeout(r, 150)) // > 4 interval
    mux.send({ type: 'open', streamId: 's1', target: 'session:x' })
    // koneksi hidup: server masih merespons (error target tapi frame balik datang)
    const err = await mux.wait((f) => f.type === 'error')
    expect(err).toMatchObject({ streamId: 's1' })
    mux.ws.close()
  } finally {
    await h.close()
  }
})

test('frame guard: oversized frame → error tanpa putus; socket tetap hidup', async () => {
  await withServe(['hi'], async ({ h }) => {
    const mux = await connectMux(h)
    mux.ws.send('x'.repeat(300 * 1024))
    const err = await mux.wait((f) => f.type === 'error' && f.streamId === '')
    expect((err as { message: string }).message).toMatch(/256 KB/)
    // socket masih hidup: open valid tetap dijawab
    mux.send({ type: 'open', streamId: 'ok', target: 'session:x' })
    await mux.wait((f) => f.type === 'error' && f.streamId === 'ok')
    mux.ws.close()
  })
})

test('frame guard: JSON rusak dan type tak dikenal → error; cancel streamId asing → drop (socket hidup)', async () => {
  await withServe(['hi'], async ({ h }) => {
    const mux = await connectMux(h)
    mux.ws.send('{')
    const badJson = await mux.wait((f) => f.type === 'error' && /invalid JSON/.test((f as { message: string }).message))
    expect((badJson as { message: string }).message).toMatch(/invalid JSON/)
    mux.ws.send('{"type":"item","streamId":"a"}')
    const unknown = await mux.wait((f) => f.type === 'error' && /unknown frame type/.test((f as { message: string }).message))
    expect((unknown as { message: string }).message).toMatch(/unknown frame type/)
    // cancel untuk stream tak dikenal → TIDAK ada frame balik, tapi socket tetap hidup
    const before = mux.frames.length
    mux.send({ type: 'cancel', streamId: 'tidak-ada' })
    await new Promise((r) => setTimeout(r, 80))
    expect(mux.frames.length).toBe(before)
    mux.send({ type: 'open', streamId: 'ok', target: 'session:x' })
    await mux.wait((f) => f.type === 'error' && f.streamId === 'ok')
    mux.ws.close()
  })
})

test('frame guard: open duplikat (streamId sama) → error duplicate; open tetap terpakai', async () => {
  await withServe(['hi'], async ({ h, base }) => {
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string }
    const mux = await connectMux(h)
    mux.send({ type: 'open', streamId: 'dup', target: `session:${created.id}` })
    await mux.wait(isItem('ready'))
    mux.send({ type: 'open', streamId: 'dup', target: `session:${created.id}` })
    const err = await mux.wait((f) => f.type === 'error' && f.streamId === 'dup')
    expect((err as { message: string }).message).toMatch(/duplicate/)
    mux.ws.close()
  })
})

test('busy terbebas setelah cancel: POST messages lagi → 202 (bukan 409)', async () => {
  const { startServe } = await import('../src/serve')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => (release = r))
  const h = await startServe({
    port: 0,
    cwd: mkdtempSync(join(tmpdir(), 'bccli-serve-')),
    provider: {
      async chat(req) {
        req.onText?.('tahan')
        await gate
        return { text: 'tahan', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
      },
      async listModels() {
        return ['m']
      },
    },
    env: { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-serve-')), BOTCONNECTOR_API_KEY: 'k' } as NodeJS.ProcessEnv,
  })
  try {
    const base = `http://127.0.0.1:${h.port}`
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string }
    expect((await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'a' })).status).toBe(202)
    expect((await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'b' })).status).toBe(409)
    expect((await api(base, h.token, `/v1/sessions/${created.id}/cancel`, {})).status).toBe(200)
    release() // stub chat tidak menghormati signal — selesai agar agent.run resolve + busy terkuras
    await new Promise((r) => setTimeout(r, 150))
    expect((await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'c' })).status).toBe(202)
  } finally {
    release()
    await h.close()
  }
})
