import { expect, test, vi } from 'vitest'
import { createProvider } from '../src/provider'
import { splitThinking, ThinkSplitter } from '../src/thinking'

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
const chunk = (delta: object) => ({ choices: [{ delta }] })

test('ThinkSplitter separates <think> blocks even when tags are cut across chunks', () => {
  const s = new ThinkSplitter()
  const parts = ['<th', 'ink>hitung 17', '*23</thi', 'nk>\n\nJawabannya 391. Harga <5', ' dolar'].map((d) => s.push(d))
  parts.push(s.flush())
  expect(parts.map((p) => p.thinking).join('')).toBe('hitung 17*23')
  expect(parts.map((p) => p.text).join('')).toBe('\n\nJawabannya 391. Harga <5 dolar')
  expect(splitThinking('tanpa tag <b>tebal</b>')).toEqual({ text: 'tanpa tag <b>tebal</b>', thinking: '' })
})

test('the provider reports reasoning_content and <think> text as thinking, never as the answer', async () => {
  const f = vi.fn(async () =>
    sse([chunk({ reasoning_content: 'langkah 1. ' }), chunk({ content: '<think>langkah 2' }), chunk({ content: '</think>391' })]),
  )
  const thought: string[] = []
  const text: string[] = []
  const c = await createProvider({ baseURL: 'http://x', model: 'm', fetch: f }).chat({
    messages: [],
    onText: (d) => text.push(d),
    onThinking: (d) => thought.push(d),
  })
  expect(c.text).toBe('391')
  expect(c.thinking).toBe('langkah 1. langkah 2')
  expect(text.join('')).toBe('391')
  expect(thought.join('')).toBe('langkah 1. langkah 2')

  const json = vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '<think>pikir</think>jawab', reasoning_content: 'r ' } }] }), {
        headers: { 'content-type': 'application/json' },
      }),
  )
  const j = await createProvider({ baseURL: 'http://x', model: 'm', fetch: json }).chat({ messages: [] })
  expect(j).toMatchObject({ text: 'jawab', thinking: 'r pikir' })
})
