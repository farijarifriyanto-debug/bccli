import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { Agent } from '../src/agent'
import { Permissions } from '../src/permissions'
import { createProvider, type ChatRequest, type Completion, type Provider, ProviderError } from '../src/provider'
import { reasoningCapability, reasoningPayload } from '../src/reasoning'
import { ALL_TOOLS } from '../src/tools/index'

function sse(events: unknown[] = []): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return JSON.parse(String(init.body))
}

test('Auto omits every reasoning override from an OpenAI-compatible request', async () => {
  const f = vi.fn(async () => sse())
  await createProvider({ baseURL: 'http://x', model: 'm', providerId: 'bc-cloud', fetch: f }).chat({
    messages: [],
    reasoning: 'auto',
  })
  const body = bodyOf(f)
  expect(body).not.toHaveProperty('reasoning_effort')
  expect(body).not.toHaveProperty('reasoning')
})

test('BotConnector high maps to reasoning_effort without changing the requested level', async () => {
  const f = vi.fn(async () => sse())
  await createProvider({ baseURL: 'http://x', model: 'm', providerId: 'bc-cloud', fetch: f }).chat({
    messages: [],
    reasoning: 'high',
  })
  expect(bodyOf(f)).toMatchObject({ reasoning_effort: 'high' })
})

test('OpenRouter uses its reasoning object contract', async () => {
  const f = vi.fn(async () => sse())
  await createProvider({ baseURL: 'http://x', model: 'm', providerId: 'openrouter', fetch: f }).chat({
    messages: [],
    reasoning: 'high',
  })
  expect(bodyOf(f)).toMatchObject({ reasoning: { effort: 'high' } })
})

test('unsupported manual levels fail clearly and are never downgraded', async () => {
  const f = vi.fn(async () => sse())
  const p = createProvider({ baseURL: 'http://x', model: 'm', providerId: 'openai', fetch: f })
  await expect(p.chat({ messages: [], reasoning: 'max' })).rejects.toBeInstanceOf(ProviderError)
  await expect(p.chat({ messages: [], reasoning: 'max' })).rejects.toThrow(/tidak mendukung reasoning level 'max'.*Auto\/Low\/Medium\/High/i)
  expect(f).not.toHaveBeenCalled()
})

test('unknown/custom providers only allow Auto unless a contract is added', () => {
  expect(reasoningCapability('corp')).toBeUndefined()
  expect(reasoningPayload('corp', 'auto')).toEqual({})
  expect(() => reasoningPayload('corp', 'high')).toThrow(/Gunakan Auto/)
})

function scripted(steps: Completion[], requests: ChatRequest[]): Provider {
  return {
    async chat(req) {
      requests.push({ ...req, signal: undefined, onText: undefined, onThinking: undefined })
      const next = steps.shift()
      if (!next) throw new Error('script exhausted')
      return next
    },
    async listModels() {
      return []
    },
  }
}

test('reasoning stays on every request after a tool call', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-reasoning-agent-'))
  writeFileSync(join(cwd, 'a.txt'), 'hello')
  const requests: ChatRequest[] = []
  const provider = scripted(
    [
      { text: '', toolCalls: [{ id: 'r1', name: 'read', arguments: '{"path":"a.txt"}' }] },
      { text: 'done', toolCalls: [] },
    ],
    requests,
  )
  const agent = new Agent({
    provider,
    tools: ALL_TOOLS,
    permissions: new Permissions('default', [], cwd),
    systemPrompt: 'SYS',
    cwd,
    reasoning: 'high',
  })
  await agent.run('read it', new AbortController().signal)
  expect(requests).toHaveLength(2)
  expect(requests.map((r) => r.reasoning)).toEqual(['high', 'high'])
})

test('changing Agent reasoning applies to the next request without touching permissions', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-reasoning-next-'))
  const requests: ChatRequest[] = []
  const provider = scripted([{ text: 'one', toolCalls: [] }, { text: 'two', toolCalls: [] }], requests)
  const permissions = new Permissions('acceptEdits', [], cwd)
  const agent = new Agent({ provider, tools: ALL_TOOLS, permissions, systemPrompt: 'SYS', cwd })
  await agent.run('one', new AbortController().signal)
  agent.reasoning = 'max'
  await agent.run('two', new AbortController().signal)
  expect(requests.map((r) => r.reasoning)).toEqual(['auto', 'max'])
  expect(agent.permissions.mode).toBe('acceptEdits')
})
