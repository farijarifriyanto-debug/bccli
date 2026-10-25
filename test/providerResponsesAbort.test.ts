import { expect, test } from 'vitest'
import { createProvider } from '../src/provider'

/**
 * The native Responses stream (bc-cloud/gpt-6-luna) is read with `for await`. Without the
 * caller's signal that loop waits forever on a stalled body, so an aborted turn keeps the
 * connection (and the download) alive in the background.
 */
test('aborting a native Responses stream settles instead of waiting forever', async () => {
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({
    start() {
      // Abort while the reader is waiting for the first chunk.
      controller.abort()
    },
  })
  const provider = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test',
    providerId: 'bc-cloud',
    model: 'gpt-6-luna',
    fetch: (async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch,
  })

  const chat = provider.chat({ messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })
  const outcome = await Promise.race([
    chat.then(
      () => 'settled',
      () => 'settled',
    ),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 2000)),
  ])

  expect(outcome).toBe('settled')
})
