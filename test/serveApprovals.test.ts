import { expect, test } from 'vitest'
import type { Provider } from '../src/provider'
import { api, connectMux, isItem, withServe } from './helpers/serve'

/**
 * Stub: turn 1 meminta tool bash `echo CANARY_APPROVED` (kind bash → permissions
 * default → 'ask'), turn 2 membalas text biasa.
 */
function toolFirst(): Provider {
  let n = 0
  return {
    async chat(req) {
      n++
      if (n === 1) {
        return {
          text: '',
          toolCalls: [{ id: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'echo CANARY_APPROVED' }) }],
          usage: { inputTokens: 1, outputTokens: 1 },
        }
      }
      req.onText?.('selesai')
      return { text: 'selesai', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }
    },
    async listModels() {
      return ['m']
    },
  }
}

test('ask: approval_request → jawab yes → tool_result CANARY_APPROVED → result done; jawaban telat 404; answer invalid 400', async () => {
  await withServe(toolFirst(), async ({ h, base }) => {
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string }
    const mux = await connectMux(h)
    mux.send({ type: 'open', streamId: 'st1', target: `session:${created.id}` })
    await mux.wait(isItem('ready'))
    expect((await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'jalankan' })).status).toBe(202)
    const approval = await mux.wait(isItem('approval_request'))
    const requestId = (approval as { value: { requestId: string; tool: string; target: string } }).value.requestId
    expect((approval as { value: { tool: string; target: string } }).value).toMatchObject({
      tool: 'bash',
      target: 'echo CANARY_APPROVED',
    })
    // belum ada tool_result — tool belum dieksekusi
    expect(mux.items().some((i) => i.value.type === 'tool_result')).toBe(false)
    // answer invalid → 400
    expect((await api(base, h.token, `/v1/sessions/${created.id}/approvals`, { requestId, answer: 'maybe' })).status).toBe(400)
    // jawab yes → tool jalan
    const ok = await api(base, h.token, `/v1/sessions/${created.id}/approvals`, { requestId, answer: 'yes' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ accepted: true })
    const tr = await mux.wait(isItem('tool_result'))
    expect(String((tr as { value: { output: string } }).value.output)).toContain('CANARY_APPROVED')
    const result = await mux.wait(isItem('result'))
    expect((result as { value: { stopReason: string } }).value.stopReason).toBe('done')
    // jawaban telat → 404 (sekali pakai)
    const late = await api(base, h.token, `/v1/sessions/${created.id}/approvals`, { requestId, answer: 'yes' })
    expect(late.status).toBe(404)
    mux.ws.close()
  })
})

test('fail-closed: cancel turn → result aborted, tool TIDAK jalan, approval pending → no (jawaban telat 404)', async () => {
  await withServe(toolFirst(), async ({ h, base }) => {
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string }
    const mux = await connectMux(h)
    mux.send({ type: 'open', streamId: 'st1', target: `session:${created.id}` })
    await mux.wait(isItem('ready'))
    await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'jalankan' })
    const approval = await mux.wait(isItem('approval_request'))
    const requestId = (approval as { value: { requestId: string } }).value.requestId
    const cancel = await api(base, h.token, `/v1/sessions/${created.id}/cancel`, {})
    expect(cancel.status).toBe(200)
    expect(await cancel.json()).toMatchObject({ cancelled: true })
    const result = await mux.wait(isItem('result'))
    expect((result as { value: { stopReason: string } }).value.stopReason).toBe('aborted')
    // echo TIDAK pernah dieksekusi (tool_result mungkin muncul sbg penanda ditolak — cek outputnya)
    expect(
      mux.items().some(
        (i) =>
          i.value.type === 'tool_result' &&
          String((i.value as { output?: string }).output ?? '').includes('CANARY_APPROVED'),
      ),
    ).toBe(false)
    // approval pending sudah diselesaikan → jawaban telat 404
    expect((await api(base, h.token, `/v1/sessions/${created.id}/approvals`, { requestId, answer: 'yes' })).status).toBe(404)
    mux.ws.close()
  })
})

test('replay: pending approval di-replay saat stream dibuka ulang dengan requestId sama', async () => {
  await withServe(toolFirst(), async ({ h, base }) => {
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string }
    const mux1 = await connectMux(h)
    mux1.send({ type: 'open', streamId: 'st1', target: `session:${created.id}` })
    await mux1.wait(isItem('ready'))
    await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'jalankan' })
    const approval = await mux1.wait(isItem('approval_request'))
    const requestId = (approval as { value: { requestId: string } }).value.requestId
    // putus TANPA menjawab
    mux1.send({ type: 'cancel', streamId: 'st1' })
    await mux1.wait((f) => f.type === 'end')
    mux1.ws.close()
    // stream baru → ready diikuti approval_request replay (requestId sama)
    const mux2 = await connectMux(h)
    mux2.send({ type: 'open', streamId: 'st2', target: `session:${created.id}` })
    await mux2.wait(isItem('ready'))
    const replay = await mux2.wait(isItem('approval_request'))
    expect((replay as { value: { requestId: string } }).value.requestId).toBe(requestId)
    // jawab di koneksi baru → tool berjalan
    expect((await api(base, h.token, `/v1/sessions/${created.id}/approvals`, { requestId, answer: 'yes' })).status).toBe(200)
    const tr = await mux2.wait(isItem('tool_result'))
    expect(String((tr as { value: { output: string } }).value.output)).toContain('CANARY_APPROVED')
    mux2.ws.close()
  })
})

test('bypassPermissions: tool berisiko jalan TANPA approval_request', async () => {
  await withServe(toolFirst(), async ({ h, base }) => {
    const created = (await (await api(base, h.token, '/v1/sessions', { permissionMode: 'bypassPermissions' })).json()) as {
      id: string
      permissionMode: string
    }
    expect(created.permissionMode).toBe('bypassPermissions')
    const mux = await connectMux(h)
    mux.send({ type: 'open', streamId: 'st1', target: `session:${created.id}` })
    await mux.wait(isItem('ready'))
    await api(base, h.token, `/v1/sessions/${created.id}/messages`, { prompt: 'jalankan' })
    const tr = await mux.wait(isItem('tool_result'))
    expect(String((tr as { value: { output: string } }).value.output)).toContain('CANARY_APPROVED')
    const result = await mux.wait(isItem('result'))
    expect((result as { value: { stopReason: string } }).value.stopReason).toBe('done')
    expect(mux.items().some((i) => i.value.type === 'approval_request')).toBe(false)
    mux.ws.close()
  })
})

test('approvals: sesi tak dikenal → 404; requestId asing → 404', async () => {
  await withServe(toolFirst(), async ({ h, base }) => {
    const created = (await (await api(base, h.token, '/v1/sessions', {})).json()) as { id: string }
    const unknownSession = await api(base, h.token, '/v1/sessions/tidak-ada/approvals', { requestId: 'x', answer: 'yes' })
    expect(unknownSession.status).toBe(404)
    const unknownId = await api(base, h.token, `/v1/sessions/${created.id}/approvals`, { requestId: 'asing', answer: 'yes' })
    expect(unknownId.status).toBe(404)
  })
})
