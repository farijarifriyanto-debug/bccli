import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { Agent } from '../src/agent'
import { Permissions } from '../src/permissions'
import type { ChatMessage, ChatRequest, Completion, Provider } from '../src/provider'
import { defineTool } from '../src/tools/types'
import { isStub, pruneOldFetches, WebBudget } from '../src/webBudget'

const fetchCall = (id: string, url: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'fetch', arguments: JSON.stringify({ url }) } }],
})
const result = (id: string, chars: number): ChatMessage => ({ role: 'tool', tool_call_id: id, content: 'x'.repeat(chars) })
const conversation = (n: number, chars: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => [fetchCall(`c${i}`, `https://e.com/${i}`), result(`c${i}`, chars)]).flat()
const stubbed = (m: ChatMessage[]) => m.filter((x) => x.role === 'tool' && isStub(x.content)).length

test('old fetch results become stubs once they exceed 20k tokens, newest ~40k tokens stay', () => {
  const msgs = conversation(8, 36_000)
  expect(pruneOldFetches(msgs)).toBe(true)
  expect(stubbed(msgs)).toBe(4)
  const first = msgs[1] as { content: string }
  expect(first.content).toContain('https://e.com/0')
  expect(first.content).toContain('fetch')
  expect(first.content.length).toBeLessThan(300)
  expect(msgs.slice(-1)[0]).toMatchObject({ role: 'tool', content: 'x'.repeat(36_000) })
})

test('nothing is touched while the old part is under 20k tokens (keeps the prompt cache intact)', () => {
  const msgs = conversation(6, 36_000)
  const before = JSON.stringify(msgs)
  expect(pruneOldFetches(msgs)).toBe(false)
  expect(JSON.stringify(msgs)).toBe(before)
})

test('only fetch results are pruned, and pruning twice changes nothing more', () => {
  const msgs = conversation(8, 36_000)
  msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: 'r', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }] }, result('r', 500_000))
  pruneOldFetches(msgs)
  expect(msgs.slice(-1)[0]).toMatchObject({ content: 'x'.repeat(500_000) })
  expect(pruneOldFetches(msgs)).toBe(false)
})

test('WebBudget: fetches per turn and characters per session', () => {
  const b = new WebBudget({ perTurn: 2, sessionChars: 100 })
  expect(b.take()).toBeUndefined()
  expect(b.take()).toBeUndefined()
  expect(b.take()).toMatch(/2 fetch/)
  b.startTurn()
  expect(b.take()).toBeUndefined()
  b.record(150)
  b.startTurn()
  expect(b.take()).toMatch(/rangkum/i)
  b.reset()
  expect(b.take()).toBeUndefined()
})

function harness(chars: number) {
  const requests: ChatRequest[] = []
  const steps: Completion[] = []
  const provider: Provider = {
    async chat(req) {
      requests.push({ ...req, messages: structuredClone(req.messages) })
      return steps.shift() as Completion
    },
    async listModels() {
      return []
    },
  }
  let ran = 0
  const fake = defineTool({
    name: 'fetch',
    description: 'fake',
    schema: z.object({ url: z.string() }),
    kind: 'fetch',
    target: (i) => i.url,
    async run() {
      ran++
      return { output: 'x'.repeat(chars) }
    },
  })
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-web-'))
  const agent = new Agent({ provider, tools: [fake], permissions: new Permissions('allowAll', [], cwd), systemPrompt: 'SYS', cwd })
  let n = 0
  /** Runs one question in which the model fetches `calls` URLs one after another, then answers. */
  const ask = async (calls: number) => {
    for (let i = 0; i < calls; i++) steps.push({ text: '', toolCalls: [{ id: `c${n}`, name: 'fetch', arguments: JSON.stringify({ url: `https://e.com/${n++}` }) }] })
    steps.push({ text: 'selesai', toolCalls: [] })
    await agent.run('cari', new AbortController().signal)
  }
  return { agent, requests, ask, ran: () => ran }
}
const lastToolContents = (h: ReturnType<typeof harness>): string[] =>
  (h.requests[h.requests.length - 1].messages.filter((m) => m.role === 'tool') as { content: string }[]).map((m) => m.content)

test('agent: the 9th fetch in one question is refused with a "summarize instead" message', async () => {
  const h = harness(100)
  await h.ask(9)
  expect(h.ran()).toBe(8)
  expect(lastToolContents(h).at(-1)).toMatch(/8 fetch/)
})

test('agent: a new question gets a fresh per-question allowance', async () => {
  const h = harness(100)
  await h.ask(8)
  await h.ask(3)
  expect(h.ran()).toBe(11)
})

test('agent: the session character budget stops fetches until the context is cleared', async () => {
  const h = harness(100_000)
  await h.ask(4)
  expect(h.ran()).toBe(3)
  expect(lastToolContents(h).at(-1)).toMatch(/rangkum/i)
  await h.ask(1)
  expect(h.ran()).toBe(3)
  h.agent.clear()
  await h.ask(1)
  expect(h.ran()).toBe(4)
})

test('agent: old fetch results are stubbed in what the model receives (in batches, so the newest stay whole)', async () => {
  const h = harness(36_000)
  await h.ask(8)
  const sent = lastToolContents(h)
  expect(sent.filter(isStub)).toHaveLength(3)
  expect(sent.slice(-5).every((c) => c.length === 36_000)).toBe(true)
})
