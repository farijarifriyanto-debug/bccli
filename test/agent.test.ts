import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { z } from 'zod'
import type { ResponseOutputItem } from 'openai/resources/responses/responses'
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

function setup(steps: Completion[], mode: 'default' | 'plan' | 'allowAll' = 'default', maxSteps?: number | null) {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-agent-'))
  const provider = scripted(steps)
  const events: AgentEvent[] = []
  const agent = new Agent({ provider, tools: ALL_TOOLS, permissions: new Permissions(mode, [], cwd), systemPrompt: 'SYS', cwd, maxSteps })
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

test('forwards only local programmatic-safe tool names to the provider', async () => {
  const { provider, agent } = setup([reply('done')])
  agent.setTools([
    ...ALL_TOOLS,
    {
      name: 'mcp__demo__lookup',
      description: 'Read-only lookup',
      schema: z.object({ id: z.string().optional() }),
      kind: 'mcp',
      programmaticSafe: true,
      target: () => 'lookup',
      async run() {
        return { output: 'ok' }
      },
    },
    {
      name: 'mcp__demo__mutate',
      description: 'Mutation',
      schema: z.object({}),
      kind: 'mcp',
      programmaticSafe: false,
      target: () => 'mutate',
      async run() {
        return { output: 'ok' }
      },
    },
  ])
  await agent.run('compare all records', new AbortController().signal)
  expect(provider.requests[0].programmaticToolNames).toEqual(['mcp__demo__lookup'])
})

test('programmatic-safe MCP still goes through the normal MCP permission gate', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-agent-mcp-'))
  const provider = scripted([
    { text: '', toolCalls: [call('mcp__demo__lookup', { id: '42' }, 'mcp_call_1')] },
    reply('done'),
  ])
  const mcpTool = {
    name: 'mcp__demo__lookup',
    description: 'Read-only lookup',
    schema: z.object({ id: z.string().optional() }),
    kind: 'mcp' as const,
    programmaticSafe: true,
    target: () => 'lookup 42',
    async run() {
      return { output: '{"status":"active"}' }
    },
  }
  const agent = new Agent({
    provider,
    tools: [mcpTool],
    permissions: new Permissions('default', [], cwd),
    systemPrompt: 'SYS',
    cwd,
  })
  const asked: string[] = []
  agent.askPermission = async (req) => {
    asked.push(req.tool)
    return 'no'
  }
  await agent.run('compare all records', new AbortController().signal)
  expect(asked).toEqual(['mcp__demo__lookup'])
  expect(provider.requests[0].programmaticToolNames).toEqual(['mcp__demo__lookup'])
  const result = provider.requests[1].messages.find((m) => m.role === 'tool') as { content: string }
  expect(result.content).toMatch(/declined/)
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

test('stops at an explicitly configured step limit', async () => {
  const loop = Array.from({ length: 5 }, (_, i) => ({ text: '', toolCalls: [call('glob', { pattern: '*' }, `g${i}`)] }))
  const { events, agent } = setup(loop, 'default', 3)
  await agent.run('x', new AbortController().signal)
  expect(events.at(-1)).toEqual({ type: 'stepLimit', maxSteps: 3 })
})

test('has no default step limit', async () => {
  const loop = Array.from({ length: 55 }, () => ({ text: '', toolCalls: [], finishReason: 'continue' as const }))
  const { events, provider, agent } = setup([...loop, reply('done')])
  await agent.run('x', new AbortController().signal)
  expect(provider.requests).toHaveLength(56)
  expect(events.some((event) => event.type === 'stepLimit')).toBe(false)
  expect(events.at(-1)?.type).toBe('done')
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

test('PTC chain continues through program_output without client compaction and preserves caller', async () => {
  const caller = { type: 'program' as const, caller_id: 'call_prog_1' }
  const { cwd, provider, events, agent } = setup([
    {
      text: '',
      toolCalls: [{ id: 'call_child_1', name: 'read', arguments: '{"path":"a.txt"}', caller }],
      responsesOutputItems: [
        {
          type: 'program',
          id: 'prog_1',
          call_id: 'call_prog_1',
          code: 'const x = await tools.read({path:"a.txt"}); text(x);',
          fingerprint: 'fp_1',
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_child_1',
          name: 'read',
          arguments: '{"path":"a.txt"}',
          caller,
          status: 'completed',
        },
      ] as unknown as ResponseOutputItem[],
      usage: { inputTokens: 900, outputTokens: 20 },
      finishReason: 'tool_calls',
    },
    {
      text: '',
      toolCalls: [],
      responsesOutputItems: [
        {
          type: 'program_output',
          id: 'prog_out_1',
          call_id: 'call_prog_1',
          result: '{"excerpt":"hello"}',
          status: 'completed',
        },
      ] as unknown as ResponseOutputItem[],
      usage: { inputTokens: 900, outputTokens: 10 },
      finishReason: 'continue',
    },
    {
      text: 'done',
      toolCalls: [],
      responsesOutputItems: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'done', annotations: [], logprobs: [] }],
        },
      ] as unknown as ResponseOutputItem[],
      usage: { inputTokens: 900, outputTokens: 5 },
      finishReason: 'stop',
    },
  ])
  writeFileSync(join(cwd, 'a.txt'), 'hello')
  ;(agent as unknown as { contextWindow: number }).contextWindow = 1000

  await agent.run('inspect a.txt', new AbortController().signal)

  expect(provider.requests).toHaveLength(3)
  expect(events.some((e) => e.type === 'compacted')).toBe(false)
  const childOutput = provider.requests[1].messages.find((m) => m.role === 'tool')
  expect(childOutput).toMatchObject({
    role: 'tool',
    tool_call_id: 'call_child_1',
    responses_caller: caller,
  })
  const third = provider.requests[2].messages
  expect(third.some((m) => m.role === 'assistant' && m.responses_output_items?.some((item) => item.type === 'program_output'))).toBe(true)
  expect(events.at(-1)?.type).toBe('done')
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

test('tracks cached and cache-write token usage from provider telemetry', async () => {
  const { agent } = setup([{
    ...reply('done'),
    usage: { inputTokens: 100, outputTokens: 7, cachedInputTokens: 80, cacheWriteTokens: 5 },
  }])
  await agent.run('hi', new AbortController().signal)
  expect(agent.totalUsage).toEqual({
    inputTokens: 100,
    outputTokens: 7,
    cachedInputTokens: 80,
    cacheWriteTokens: 5,
  })
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

test('a resumed history bigger than the window compacts before the first real request', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-agent-resume-'))
  const provider = scripted([reply('RINGKASAN-RESUME'), reply('done')])
  const agent = new Agent({
    provider,
    tools: ALL_TOOLS,
    permissions: new Permissions('default', [], cwd),
    systemPrompt: 'SYS',
    cwd,
    contextWindow: 500,
  })
  agent.load([
    { role: 'user', content: 'x'.repeat(4000) },
    { role: 'assistant', content: 'ok' },
  ])
  await agent.run('continue the work', new AbortController().signal)
  expect(provider.requests).toHaveLength(2)
  const compactRequest = provider.requests[0]
  expect(compactRequest.messages.at(-1)).toEqual({ role: 'user', content: expect.stringContaining('Summarize the conversation') })
  const realRequest = provider.requests[1]
  expect(realRequest.messages.some((m) => m.role === 'user' && String(m.content).includes('Summary of the previous conversation'))).toBe(true)
  expect(realRequest.messages.at(-1)).toEqual({ role: 'user', content: 'continue the work' })
})

test('compaction trims history that would overflow even the summary request, at turn boundaries only', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-agent-trim-'))
  const provider = scripted([reply('RINGKASAN-PENDEK'), reply('done')])
  const agent = new Agent({
    provider,
    tools: ALL_TOOLS,
    permissions: new Permissions('default', [], cwd),
    systemPrompt: 'SYS',
    cwd,
    contextWindow: 2000,
  })
  // Five complete turns, each with a tool exchange, well past the 1600-token compaction budget.
  const turn = (i: number) =>
    [
      { role: 'user', content: `tugas ${i} ${'u'.repeat(2000)}` },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${i}`, type: 'function' as const, function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: `c${i}`, content: 'r'.repeat(1000) },
      { role: 'assistant', content: `selesai ${i}` },
    ] as const
  agent.load([turn(0), turn(1), turn(2), turn(3), turn(4)].flat() as never)
  await agent.run('lanjut', new AbortController().signal)
  const compactMessages = provider.requests[0].messages
  const withoutSystemAndPrompt = compactMessages.slice(1, -1)
  expect(JSON.stringify(withoutSystemAndPrompt).length / 4).toBeLessThan(1600)
  // Trimmed at a user boundary: the first message is a user turn, no orphan tool reply.
  expect(withoutSystemAndPrompt[0].role).toBe('user')
  const answered = new Set(
    withoutSystemAndPrompt.flatMap((m) => (m.role === 'assistant' ? (m.tool_calls ?? []).map((c) => c.id) : [])),
  )
  for (const m of withoutSystemAndPrompt) {
    if (m.role === 'tool') expect(answered.has((m as { tool_call_id: string }).tool_call_id)).toBe(true)
  }
  // Oldest turns were dropped, recent ones kept.
  expect(withoutSystemAndPrompt.some((m) => m.role === 'user' && String(m.content).startsWith('tugas 0'))).toBe(false)
  expect(withoutSystemAndPrompt.some((m) => m.role === 'user' && String(m.content).startsWith('tugas 4'))).toBe(true)
})

test('a tool that throws outside run() still gets an answer; the turn survives', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-agent-throw-'))
  const provider = scripted([{ text: '', toolCalls: [call('boom', {}, 'b1')] }, reply('recovered')])
  const boom = {
    name: 'boom',
    description: 'always explodes',
    schema: z.object({}),
    kind: 'read' as const,
    target: () => {
      throw new Error('target exploded')
    },
    async run() {
      return { output: 'never reached' }
    },
  }
  const events: AgentEvent[] = []
  const agent = new Agent({ provider, tools: [boom], permissions: new Permissions('default', [], cwd), systemPrompt: 'SYS', cwd })
  agent.onEvent = (e) => events.push(e)
  await agent.run('go', new AbortController().signal)
  expect(provider.requests).toHaveLength(2)
  const toolMsg = provider.requests[1].messages.find((m) => m.role === 'tool' && m.tool_call_id === 'b1') as
    | { content: string }
    | undefined
  expect(toolMsg?.content).toContain('target exploded')
  expect(events.at(-1)?.type).toBe('done')
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

test('images from a tool result are injected as a user parts message', async () => {
  const { cwd, provider, agent } = setup([
    { text: '', toolCalls: [call('read', { path: 'logo.png' })] },
    reply('done'),
  ])
  writeFileSync(
    join(cwd, 'logo.png'),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 3)]),
  )
  await agent.run('lihat logo', new AbortController().signal)
  const messages = provider.requests[1].messages
  const toolIndex = messages.findIndex((m) => m.role === 'tool')
  expect((messages[toolIndex] as unknown as { content: string }).content).toContain('[image attached]')
  const next = messages[toolIndex + 1] as unknown as {
    role: string
    content: { type: string; text?: string; image_url?: { url: string } }[]
  }
  expect(next.role).toBe('user')
  expect(next.content[0]).toEqual({ type: 'text', text: 'Image read from logo.png.' })
  expect(next.content[1].type).toBe('image_url')
  expect(next.content[1].image_url?.url).toMatch(/^data:image\/png;base64,/)
})

test('usageCap.tokens blocks further model calls and emits budgetExceeded', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-agent-'))
  const provider = scripted([{ ...reply('first'), usage: { inputTokens: 90, outputTokens: 90 } }])
  const events: AgentEvent[] = []
  const agent = new Agent({
    provider, tools: ALL_TOOLS, permissions: new Permissions('default', [], cwd), systemPrompt: 'SYS', cwd,
    usageCap: { tokens: 100 }, budgetModel: 'bc-cloud/glm-5.3-flash',
  })
  agent.onEvent = (e) => events.push(e)
  await agent.run('satu', new AbortController().signal)
  expect(provider.requests.length).toBe(1)
  expect(events.some((e) => e.type === 'budgetExceeded')).toBe(false)
  await agent.run('dua', new AbortController().signal)
  expect(provider.requests.length).toBe(1) // model tidak dipanggil lagi
  expect(events.find((e) => e.type === 'budgetExceeded')).toEqual({ type: 'budgetExceeded', kind: 'tokens', used: 180, limit: 100 })
})

test('usageCap.usd blocks using prices matched against the model ref', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-agent-'))
  const provider = scripted([{ ...reply('first'), usage: { inputTokens: 400_000, outputTokens: 100_000 } }])
  const events: AgentEvent[] = []
  const agent = new Agent({
    provider, tools: ALL_TOOLS, permissions: new Permissions('default', [], cwd), systemPrompt: 'SYS', cwd,
    usageCap: { usd: 1, prices: { glm: { input: 2, output: 8 } } }, budgetModel: 'bc-cloud/glm-5.3-flash',
  })
  agent.onEvent = (e) => events.push(e)
  await agent.run('satu', new AbortController().signal)
  await agent.run('dua', new AbortController().signal)
  expect(provider.requests.length).toBe(1)
  expect(events.find((e) => e.type === 'budgetExceeded')).toEqual({ type: 'budgetExceeded', kind: 'usd', used: 1.6, limit: 1 })
})
