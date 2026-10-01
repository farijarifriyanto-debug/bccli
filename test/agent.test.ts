import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Agent, type AgentEvent } from '../src/agent'
import { Permissions } from '../src/permissions'
import { type ChatRequest, type Completion, type Provider, ProviderError } from '../src/provider'
import { ALL_TOOLS } from '../src/tools/index'

function scripted(steps: Completion[]): Provider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  return {
    requests,
    async chat(req) {
      requests.push(structuredClone({ ...req, signal: undefined, onText: undefined, onThinking: undefined }))
      const next = steps.shift()
      if (!next) throw new Error('script exhausted')
      if (next.text) req.onText?.(next.text)
      return next
    },
    async listModels() {
      return []
    },
  }
}
const call = (name: string, args: unknown, id = `id_${name}`) => ({ id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
const reply = (text: string): Completion => ({ text, toolCalls: [] })

function setup(steps: Completion[], mode: 'default' | 'plan' | 'allowAll' = 'default') {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-agent-'))
  const provider = scripted(steps)
  const events: AgentEvent[] = []
  const agent = new Agent({ provider, tools: ALL_TOOLS, permissions: new Permissions(mode, [], cwd), systemPrompt: 'SYS', cwd })
  agent.onEvent = (e) => events.push(e)
  return { cwd, provider, events, agent }
}

test('runs read then answers; sends system prompt and tools', async () => {
  const { cwd, provider, events, agent } = setup([{ text: '', toolCalls: [call('read', { path: 'a.txt' })] }, reply('done')])
  writeFileSync(join(cwd, 'a.txt'), 'hello')
  await agent.run('baca a.txt', new AbortController().signal)
  expect(provider.requests[0].messages[0]).toEqual({ role: 'system', content: 'SYS' })
  expect(provider.requests[0].tools?.length).toBe(7)
  const toolMsg = provider.requests[1].messages.find((m) => m.role === 'tool')
  expect(toolMsg).toMatchObject({ role: 'tool', tool_call_id: 'id_read' })
  expect((toolMsg as { content: string }).content).toContain('hello')
  expect(events.map((e) => e.type).filter((t) => t !== 'usage')).toEqual(['toolStart', 'toolEnd', 'text', 'done'])
})

test('asks permission for edits; "no" is reported to the model', async () => {
  const { cwd, provider, agent } = setup([
    { text: '', toolCalls: [call('write', { path: 'n.txt', content: 'x' })] },
    reply('ok'),
  ])
  const asked: string[] = []
  agent.askPermission = async (req) => {
    asked.push(`${req.tool}:${req.target}:${req.sessionRules?.join(',')}`)
    return 'no'
  }
  await agent.run('tulis', new AbortController().signal)
  expect(asked).toEqual(['write:n.txt:edit(project)'])
  expect(() => readFileSync(join(cwd, 'n.txt'))).toThrow()
  const toolMsg = provider.requests[1].messages.find((m) => m.role === 'tool') as { content: string }
  expect(toolMsg.content).toMatch(/declined/)
})

test('"session" answer allows later calls of the same kind without asking', async () => {
  const { agent } = setup([
    { text: '', toolCalls: [call('write', { path: 'a.txt', content: '1' }, 'w1')] },
    { text: '', toolCalls: [call('write', { path: 'b.txt', content: '2' }, 'w2')] },
    reply('ok'),
  ])
  let asks = 0
  agent.askPermission = async () => {
    asks++
    return 'session'
  }
  await agent.run('x', new AbortController().signal)
  expect(asks).toBe(1)
})

test('plan mode denies edits without asking', async () => {
  const { provider, agent } = setup([{ text: '', toolCalls: [call('bash', { command: 'ls' })] }, reply('plan')], 'plan')
  agent.askPermission = async () => {
    throw new Error('must not ask')
  }
  await agent.run('x', new AbortController().signal)
  expect((provider.requests[1].messages.find((m) => m.role === 'tool') as { content: string }).content).toMatch(/plan mode/)
})

test('unknown tools and malformed arguments become error results, not crashes', async () => {
  const { provider, events, agent } = setup([
    { text: '', toolCalls: [call('teleport', {}, 'u1'), call('read', '{not json', 'u2'), call('read', { nope: 1 }, 'u3')] },
    reply('sorry'),
  ])
  await agent.run('x', new AbortController().signal)
  const results = provider.requests[1].messages.filter((m) => m.role === 'tool') as { content: string }[]
  expect(results[0].content).toMatch(/does not exist/)
  expect(results[1].content).toMatch(/JSON/)
  expect(results[2].content).toMatch(/Invalid arguments/)
  expect(events.at(-1)?.type).toBe('done')
})

test('stops at the step limit', async () => {
  const loop = Array.from({ length: 5 }, (_, i) => ({ text: '', toolCalls: [call('glob', { pattern: '*' }, `g${i}`)] }))
  const { events, agent } = setup(loop)
  ;(agent as unknown as { maxSteps: number }).maxSteps = 3
  await agent.run('x', new AbortController().signal)
  expect(events.at(-1)?.type).toBe('stepLimit')
})

test('provider errors become an error event', async () => {
  const { events, agent } = setup([])
  await agent.run('x', new AbortController().signal)
  expect(events.at(-1)).toEqual({ type: 'error', message: 'script exhausted' })
})

test('a 400 about tools suggests switching model', async () => {
  const { events, agent } = setup([])
  agent.provider = {
    async chat() {
      throw new ProviderError('400 dari x: tools are not supported for this model', 400)
    },
    async listModels() {
      return []
    },
  }
  await agent.run('x', new AbortController().signal)
  expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('/model') })
})

test('abort before tools answers every pending call and emits aborted', async () => {
  const controller = new AbortController()
  const { agent, events } = setup([{ text: '', toolCalls: [call('glob', { pattern: '*' }, 'a'), call('glob', { pattern: '*' }, 'b')] }])
  agent.onEvent = (e) => {
    events.push(e)
    if (e.type === 'toolStart') controller.abort()
  }
  await agent.run('x', controller.signal)
  const tools = agent.messages.filter((m) => m.role === 'tool')
  expect(tools.map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(['a', 'b'])
  expect(events.at(-1)?.type).toBe('aborted')
})

test('compacts when the last prompt used most of the context window', async () => {
  const { provider, events, agent } = setup([
    { ...reply('first'), usage: { inputTokens: 900, outputTokens: 10 } },
    reply('RINGKASAN'),
    reply('second'),
  ])
  ;(agent as unknown as { contextWindow: number }).contextWindow = 1000
  await agent.run('satu', new AbortController().signal)
  await agent.run('dua', new AbortController().signal)
  expect(events.some((e) => e.type === 'compacted')).toBe(true)
  expect(provider.requests[2].messages[1]).toEqual({ role: 'user', content: expect.stringContaining('RINGKASAN') })
})

test('estimates usage when the provider sends none, so compaction still triggers', async () => {
  const { events, agent } = setup([reply('x'.repeat(400)), reply('RINGKASAN'), reply('after')])
  ;(agent as unknown as { contextWindow: number }).contextWindow = 100
  await agent.run('y'.repeat(400), new AbortController().signal)
  expect(agent.totalUsage.inputTokens).toBeGreaterThan(90)
  expect(agent.totalUsage.outputTokens).toBe(100)
  await agent.run('next', new AbortController().signal)
  expect(events.some((e) => e.type === 'compacted')).toBe(true)
})

test('compacting mid-turn restates the task so the next request ends with a user message', async () => {
  const { provider, agent } = setup([
    { text: '', toolCalls: [call('glob', { pattern: '*' })], usage: { inputTokens: 900, outputTokens: 1 } },
    reply('RINGKASAN'),
    reply('selesai'),
  ])
  ;(agent as unknown as { contextWindow: number }).contextWindow = 1000
  await agent.run('perbaiki bug login', new AbortController().signal)
  const after = provider.requests[2].messages
  expect(after.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('perbaiki bug login') })
})

test('an edit that cannot succeed is rejected before asking for permission', async () => {
  const { cwd, provider, agent } = setup([
    { text: '', toolCalls: [call('edit', { path: 'u.txt', old_string: 'a', new_string: 'b' })] },
    reply('ok'),
  ])
  writeFileSync(join(cwd, 'u.txt'), 'a')
  let asked = false
  agent.askPermission = async () => {
    asked = true
    return 'yes'
  }
  await agent.run('x', new AbortController().signal)
  expect(asked).toBe(false)
  expect((provider.requests[1].messages.find((m) => m.role === 'tool') as { content: string }).content).toMatch(/Read u\.txt with read/)
})

test('the compaction request still declares the tools', async () => {
  const { provider, agent } = setup([
    { ...reply('first'), usage: { inputTokens: 900, outputTokens: 10 } },
    reply('RINGKASAN'),
    reply('second'),
  ])
  ;(agent as unknown as { contextWindow: number }).contextWindow = 1000
  await agent.run('satu', new AbortController().signal)
  await agent.run('dua', new AbortController().signal)
  expect(provider.requests[1].tools?.length).toBe(7)
})

test('a tool list change during a turn applies from the next turn', async () => {
  const { cwd, provider, agent } = setup([{ text: '', toolCalls: [call('read', { path: 'a.txt' })] }, reply('ok'), reply('second')])
  writeFileSync(join(cwd, 'a.txt'), 'hello')
  const original = provider.chat.bind(provider)
  let swapped = false
  provider.chat = async (req) => {
    if (!swapped) {
      swapped = true
      agent.setTools(ALL_TOOLS.filter((t) => t.name !== 'read'))
    }
    return original(req)
  }
  await agent.run('baca', new AbortController().signal)
  expect((provider.requests[1].messages.find((m) => m.role === 'tool') as { content: string }).content).toContain('hello')
  await agent.run('lagi', new AbortController().signal)
  expect(provider.requests[2].tools?.map((t) => t.function.name)).not.toContain('read')
})

test('"all" switches to allowAll so later tools run without asking', async () => {
  const { agent } = setup([
    { text: '', toolCalls: [call('write', { path: 'a.txt', content: '1' }, 'w1')] },
    { text: '', toolCalls: [call('bash', { command: 'node -e "1"' }, 'b1')] },
    reply('ok'),
  ])
  let asks = 0
  agent.askPermission = async () => {
    asks++
    return 'all'
  }
  await agent.run('x', new AbortController().signal)
  expect(asks).toBe(1)
  expect(agent.permissions.mode).toBe('allowAll')
})

test('a repetition cut-off is reported and only the clean text is kept', async () => {
  const { events, agent } = setup([{ text: 'Halo', toolCalls: [], finishReason: 'repetition' }])
  await agent.run('x', new AbortController().signal)
  expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringContaining('mengulang') })
  expect(events).toContainEqual({ type: 'textReplace', text: 'Halo' })
  expect(agent.messages.at(-1)).toEqual({ role: 'assistant', content: 'Halo' })
})
