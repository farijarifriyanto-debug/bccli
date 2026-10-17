import { getEventListeners } from 'node:events'
import { expect, test } from 'vitest'
import { createProvider } from '../src/provider'

function okBody() {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

test('a retried request leaves no abort listener behind on the caller signal', async () => {
  let calls = 0
  const fetchMock = (async () => {
    calls++
    if (calls === 1) throw new Error('network down')
    return okBody()
  }) as typeof fetch
  const provider = createProvider({ baseURL: 'http://provider.test/v1', apiKey: 'k', model: 'm', fetch: fetchMock, retryDelayMs: 1 })
  const controller = new AbortController()
  const result = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })
  expect(calls).toBe(2)
  expect(result.text).toBe('ok')
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

test('a successful first attempt also leaves no abort listener behind', async () => {
  const fetchMock = (async () => okBody()) as typeof fetch
  const provider = createProvider({ baseURL: 'http://provider.test/v1', apiKey: 'k', model: 'm', fetch: fetchMock, retryDelayMs: 1 })
  const controller = new AbortController()
  await provider.chat({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})
