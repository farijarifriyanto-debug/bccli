import { expect, test } from 'vitest'
import { createProvider } from '../src/provider'

/**
 * Gateway Responses yang kontraknya tertinggal menolak parameter `reasoning` dengan
 * 400 "Unknown parameter: 'reasoning'". Tanpa fallback, model Luna tidak bisa dipakai
 * sama sekali pada gateway tersebut; permintaan harus diulang sekali tanpa parameter itu.
 */
test('Luna mengulang tanpa `reasoning` saat gateway menolaknya', async () => {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    if (bodies.length === 1) {
      return new Response(JSON.stringify({ error: { message: "Unknown parameter: 'reasoning'." } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'halo' }] }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  const provider = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test',
    providerId: 'bc-cloud',
    model: 'gpt-6-luna',
    fetch: fetchImpl,
  })

  const completion = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] })

  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toHaveProperty('reasoning')
  expect(bodies[1]).not.toHaveProperty('reasoning')
  expect(bodies[1]).toHaveProperty('model', 'gpt-6-luna')
  expect(completion.text).toBe('halo')
})

test('galat 400 lain tidak diulang dan tidak ditelan', async () => {
  let calls = 0
  const fetchImpl = (async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { message: 'Invalid value for context_management.' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const provider = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test',
    providerId: 'bc-cloud',
    model: 'gpt-6-luna',
    fetch: fetchImpl,
  })

  await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/400/)
  expect(calls).toBe(1)
})
