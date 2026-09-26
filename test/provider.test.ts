import { expect, test, vi } from 'vitest'
import { createProvider, ProviderError } from '../src/provider'

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
const chunk = (delta: object, extra: object = {}) => ({ choices: [{ delta, ...extra }] })

test('streams text, merges tool call fragments and reads usage', async () => {
  const fetch = vi.fn(async () =>
    sse([
      chunk({ content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }),
      chunk({}, { finish_reason: 'tool_calls' }),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      '[DONE]',
    ]),
  )
  const deltas: string[] = []
  const p = createProvider({ baseURL: 'http://x/v1', apiKey: 'k', model: 'm', fetch })
  const c = await p.chat({ messages: [{ role: 'user', content: 'hi' }], onText: (d) => deltas.push(d) })
  expect(c).toEqual({
    text: 'Hello',
    toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
    usage: { inputTokens: 10, outputTokens: 5 },
    finishReason: 'tool_calls',
  })
  expect(deltas).toEqual(['Hel', 'lo'])
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('http://x/v1/chat/completions')
  expect((init.headers as Record<string, string>).authorization).toBe('Bearer k')
  expect(JSON.parse(init.body as string)).toMatchObject({ model: 'm', stream: true })
})

test('retries 5xx then succeeds; does not retry 4xx', async () => {
  let calls = 0
  const flaky = vi.fn(async () => (++calls < 3 ? new Response('busy', { status: 503 }) : sse([chunk({ content: 'ok' })])))
  const p = createProvider({ baseURL: 'http://x', model: 'm', fetch: flaky, retryDelayMs: 0 })
  expect((await p.chat({ messages: [] })).text).toBe('ok')
  expect(flaky).toHaveBeenCalledTimes(3)

  const bad = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad model' } }), { status: 400 }))
  const q = createProvider({ baseURL: 'http://x', model: 'm', fetch: bad, retryDelayMs: 0 })
  await expect(q.chat({ messages: [] })).rejects.toThrow(/400.*bad model/)
  expect(bad).toHaveBeenCalledTimes(1)
})

test('gives up after 4 attempts with a ProviderError', async () => {
  const down = vi.fn(async () => new Response('x', { status: 500 }))
  const p = createProvider({ baseURL: 'http://x', model: 'm', fetch: down, retryDelayMs: 0 })
  await expect(p.chat({ messages: [] })).rejects.toBeInstanceOf(ProviderError)
  expect(down).toHaveBeenCalledTimes(4)
})

test('accepts a non-streaming JSON response', async () => {
  const json = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hi', tool_calls: [{ id: 't', function: { name: 'glob', arguments: '{}' } }] }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  )
  const c = await createProvider({ baseURL: 'http://x', model: 'm', fetch: json }).chat({ messages: [] })
  expect(c.text).toBe('hi')
  expect(c.toolCalls).toEqual([{ id: 't', name: 'glob', arguments: '{}' }])
})

test('listModels returns sorted ids', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }] })))
  expect(await createProvider({ baseURL: 'http://x', model: 'm', fetch: f }).listModels()).toEqual(['a', 'b'])
})

test('parallel tool calls without index stay separate when their ids differ', async () => {
  const f = vi.fn(async () =>
    sse([
      chunk({ tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{"path":"x"}' } }] }),
      chunk({ tool_calls: [{ id: 'b', function: { name: 'glob', arguments: '{"pattern":"*"}' } }] }),
    ]),
  )
  const c = await createProvider({ baseURL: 'http://x', model: 'm', fetch: f }).chat({ messages: [] })
  expect(c.toolCalls).toEqual([
    { id: 'a', name: 'read', arguments: '{"path":"x"}' },
    { id: 'b', name: 'glob', arguments: '{"pattern":"*"}' },
  ])
})

test('an error event inside the stream becomes a ProviderError', async () => {
  const f = vi.fn(async () => sse([chunk({ content: 'x' }), { error: { message: 'upstream exploded' } }]))
  await expect(createProvider({ baseURL: 'http://x', model: 'm', fetch: f }).chat({ messages: [] })).rejects.toThrow(/upstream exploded/)
})
