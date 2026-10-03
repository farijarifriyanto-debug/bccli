import { expect, test, vi } from 'vitest'
import type { ResponseOutputItem } from 'openai/resources/responses/responses'
import { completionAssistantMessage, createProvider, lunaToolPlan, ProviderError, responseContinuationInput, responseInputFromMessages, shouldEnableLunaPtc, shouldForceLunaPtc, type ChatMessage, type Completion } from '../src/provider'
import type { ToolDefinition } from '../src/tools/index'

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}
const chunk = (delta: object, extra: object = {}) => ({ choices: [{ delta, ...extra }] })

const toolDef = (name: string, description = 'tool'): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
  },
})

test('Luna stateless replay preserves PTC program fingerprint and caller linkage', () => {
  const caller = { type: 'program' as const, caller_id: 'call_prog_1' }
  const messages: ChatMessage[] = [
    { role: 'user', content: 'compare records' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_child_1',
          type: 'function',
          function: { name: 'mcp__crm__lookup', arguments: '{"id":"42"}' },
          caller,
        },
      ],
      responses_output_items: [
        {
          type: 'program',
          id: 'prog_1',
          call_id: 'call_prog_1',
          code: 'const x = await tools.mcp__crm__lookup({id:"42"}); text(JSON.stringify(x));',
          fingerprint: 'opaque_fp_1',
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_child_1',
          name: 'mcp__crm__lookup',
          arguments: '{"id":"42"}',
          caller,
          status: 'completed',
        },
      ] as unknown as ResponseOutputItem[],
    },
    {
      role: 'tool',
      tool_call_id: 'call_child_1',
      content: '{"status":"active"}',
      responses_caller: caller,
    },
  ]

  expect(responseInputFromMessages(messages)).toEqual([
    { role: 'user', content: 'compare records' },
    {
      type: 'program',
      id: 'prog_1',
      call_id: 'call_prog_1',
      code: 'const x = await tools.mcp__crm__lookup({id:"42"}); text(JSON.stringify(x));',
      fingerprint: 'opaque_fp_1',
    },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_child_1',
      name: 'mcp__crm__lookup',
      arguments: '{"id":"42"}',
      caller,
      status: 'completed',
    },
    {
      type: 'function_call_output',
      call_id: 'call_child_1',
      output: '{"status":"active"}',
      caller,
    },
  ])
})

test('Luna tool search stays off for small MCP catalogs', () => {
  const plan = lunaToolPlan([toolDef('read'), ...Array.from({ length: 19 }, (_, i) => toolDef(`mcp__demo__t${i}`))])
  expect(plan.useToolSearch).toBe(false)
  expect(plan.deferredToolCount).toBe(0)
  expect(plan.tools.some((tool) => tool.type === 'tool_search')).toBe(false)
  expect(plan.tools.some((tool) => tool.defer_loading === true)).toBe(false)
})

test('Luna tool search defers MCP tools at the catalog threshold but keeps built-ins eager', () => {
  const plan = lunaToolPlan([toolDef('read'), ...Array.from({ length: 20 }, (_, i) => toolDef(`mcp__demo__t${i}`))])
  expect(plan.useToolSearch).toBe(true)
  expect(plan.deferredToolCount).toBe(20)
  const read = plan.tools.find((tool) => tool.name === 'read')
  expect(read?.defer_loading).toBeUndefined()
  const mcp = plan.tools.filter((tool) => String(tool.name ?? '').startsWith('mcp__'))
  expect(mcp).toHaveLength(20)
  expect(mcp.every((tool) => tool.defer_loading === true)).toBe(true)
  expect(plan.tools.at(-1)).toMatchObject({ type: 'tool_search', execution: 'server' })
})

test('Luna tool search also activates for one unusually large MCP schema', () => {
  const plan = lunaToolPlan([toolDef('read'), toolDef('mcp__large__query', 'x'.repeat(33_000))])
  expect(plan.useToolSearch).toBe(true)
  expect(plan.deferredToolCount).toBe(1)
  expect(plan.deferredSchemaChars).toBeGreaterThanOrEqual(32_000)
})

test('Luna cost-aware PTC gate keeps a single small read direct', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'Read package.json and return only the version.' }]
  expect(shouldEnableLunaPtc(messages, true)).toBe(false)
})

test('Luna deterministic aggregation cue forces PTC but compare-only does not', () => {
  expect(shouldForceLunaPtc([{ role: 'user', content: 'Compare all files.' }], true)).toBe(false)
  expect(shouldForceLunaPtc([{ role: 'user', content: 'Count all records and return the total.' }], true)).toBe(true)
  expect(shouldForceLunaPtc([{ role: 'user', content: 'Hitung jumlah semua record.' }], true)).toBe(true)
  expect(shouldForceLunaPtc([{ role: 'user', content: 'Count all records.' }], false)).toBe(false)
})

test('Luna cost-aware PTC gate enables multi-source aggregation intent', () => {
  expect(
    shouldEnableLunaPtc(
      [{ role: 'user', content: 'Compare all matching files, count active records, and return the total.' }],
      true,
    ),
  ).toBe(true)
  expect(
    shouldEnableLunaPtc(
      [{ role: 'user', content: 'Bandingkan semua file lalu hitung jumlah record aktif.' }],
      true,
    ),
  ).toBe(true)
})

test('Luna cost-aware PTC gate enables after a large safe read-only result', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Inspect package.json.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'read_1', type: 'function', function: { name: 'read', arguments: '{"path":"large.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'read_1', content: 'x'.repeat(8_000) },
  ]
  expect(shouldEnableLunaPtc(messages, true)).toBe(true)
})

test('Luna cost-aware PTC gate ignores large unsafe tool output and honors kill switch', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Run one command.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'bash_1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo x"}' } }],
    },
    { role: 'tool', tool_call_id: 'bash_1', content: 'x'.repeat(20_000) },
  ]
  expect(shouldEnableLunaPtc(messages, true)).toBe(false)
  expect(shouldEnableLunaPtc([{ role: 'user', content: 'Compare all files.' }], false)).toBe(false)
})

test('Luna PTC allows only explicitly read-only MCP tools', () => {
  const readOnly = 'mcp__echo__echo'
  const writeLike = 'mcp__echo__mutate'
  const plan = lunaToolPlan(
    [toolDef(readOnly), toolDef(writeLike), toolDef('read')],
    true,
    [readOnly],
  )
  expect(plan.tools.find((tool) => tool.name === readOnly)?.allowed_callers).toEqual(['direct', 'programmatic'])
  expect(plan.tools.find((tool) => tool.name === writeLike)?.allowed_callers).toBeUndefined()
  expect(plan.tools.find((tool) => tool.name === 'read')?.allowed_callers).toEqual(['direct', 'programmatic'])
})

test('Luna PTC large-output gate accepts explicitly read-only MCP output', () => {
  const mcp = 'mcp__echo__echo'
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Inspect this source.' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'mcp_1', type: 'function', function: { name: mcp, arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'mcp_1', content: 'x'.repeat(8_000) },
  ]
  expect(shouldEnableLunaPtc(messages, true, [mcp])).toBe(true)
  expect(shouldEnableLunaPtc(messages, true, [])).toBe(false)
})

test('Luna PTC canary exposes only read/grep/glob to programs', () => {
  const plan = lunaToolPlan(
    [toolDef('read'), toolDef('grep'), toolDef('glob'), toolDef('bash'), toolDef('write'), toolDef('mcp__crm__lookup')],
    true,
  )
  expect(plan.useProgrammaticToolCalling).toBe(true)
  expect(plan.tools.at(-1)).toEqual({ type: 'programmatic_tool_calling' })
  for (const name of ['read', 'grep', 'glob']) {
    expect(plan.tools.find((tool) => tool.name === name)?.allowed_callers).toEqual(['direct', 'programmatic'])
  }
  for (const name of ['bash', 'write', 'mcp__crm__lookup']) {
    expect(plan.tools.find((tool) => tool.name === name)?.allowed_callers).toBeUndefined()
  }
})

test('Luna PTC auto plan adds no marker when there are no programmatic-safe tools', () => {
  const plan = lunaToolPlan([toolDef('bash'), toolDef('write'), toolDef('mcp__crm__lookup')], true)
  expect(plan.useProgrammaticToolCalling).toBe(false)
  expect(plan.tools.some((tool) => tool.type === 'programmatic_tool_calling')).toBe(false)
  expect(plan.tools.some((tool) => tool.allowed_callers)).toBe(false)
})

test('Luna PTC stays absent unless explicitly enabled', () => {
  const plan = lunaToolPlan([toolDef('read'), toolDef('grep')])
  expect(plan.useProgrammaticToolCalling).toBe(false)
  expect(plan.tools.some((tool) => tool.type === 'programmatic_tool_calling')).toBe(false)
  expect(plan.tools.some((tool) => tool.allowed_callers)).toBe(false)
})

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

test('detectRepetition flags a degenerate loop but not normal long text', async () => {
  const { detectRepetition } = await import('../src/provider')
  const loop = `Saya BCCLI. Saya membantu_tf${'读取'.repeat(200)}`
  expect(detectRepetition(loop)).toBe('Saya BCCLI. Saya membantu_tf'.length)
  expect(detectRepetition(`judul\n${'='.repeat(80)}\nisi`)).toBe(-1)
  expect(detectRepetition('| a | b |\n|---|---|\n'.repeat(10))).toBe(-1)
  expect(detectRepetition(' '.repeat(500))).toBe(-1)
  expect(detectRepetition('normal text '.repeat(5))).toBe(-1)
})

test('a stream stuck repeating is cut off early with finishReason "repetition"', async () => {
  let sent = 0
  const endless = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const piece = sent === 0 ? 'Halo, saya ' : '读取'
      sent++
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`))
      await new Promise((r) => setTimeout(r, 0))
    },
  })
  const f = vi.fn(async () => new Response(endless, { headers: { 'content-type': 'text/event-stream' } }))
  const c = await createProvider({ baseURL: 'http://x', model: 'm', fetch: f }).chat({ messages: [] })
  expect(c.finishReason).toBe('repetition')
  expect(c.text).toBe('Halo, saya ')
  expect(sent).toBeLessThan(1000)
})


test('BotConnector BCCLI identity headers remain attached to official Cloud requests', async () => {
  const f = vi.fn(async () => sse([]))
  await createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test_key',
    model: 'gpt-5.6-luna',
    fetch: f,
  }).chat({ messages: [] })
  const [, init] = f.mock.calls[0] as unknown as [string, RequestInit]
  const headers = init.headers as Record<string, string>
  expect(headers['x-botconnector-client']).toBe('bccli')
  expect(headers['x-botconnector-client-version']).toBe('0.4.0')
})

test('BCCLI identity headers are not leaked to custom/non-BotConnector providers', async () => {
  const f = vi.fn(async () => sse([]))
  await createProvider({
    baseURL: 'https://example.com/v1',
    apiKey: 'bc_live_test_key',
    model: 'm',
    fetch: f,
  }).chat({ messages: [] })
  const [, init] = f.mock.calls[0] as unknown as [string, RequestInit]
  const headers = init.headers as Record<string, string>
  expect(headers['x-botconnector-client']).toBeUndefined()
  expect(headers['x-botconnector-client-version']).toBeUndefined()
})


test('BotConnector GPT-6 Luna uses native Responses with typed tool items', async () => {
  const f = vi.fn(async () =>
    sse([
      { type: 'response.created', response: { id: 'resp_1' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: '{"path"' },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: ':"a.txt"}' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
      },
      {
        type: 'response.completed',
        response: { usage: { input_tokens: 120, output_tokens: 9 } },
      },
    ]),
  )
  const p = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test_key',
    model: 'gpt-6-luna',
    providerId: 'bc-cloud',
    fetch: f,
  })
  const completion = await p.chat({
    messages: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ id: 'old_call', type: 'function', function: { name: 'glob', arguments: '{"pattern":"*"}' } }],
      },
      { role: 'tool', tool_call_id: 'old_call', content: 'a.txt' },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      },
    ],
    reasoning: 'high',
  })

  expect(completion).toEqual({
    text: '',
    toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}', caller: undefined }],
    usage: { inputTokens: 120, outputTokens: 9 },
    finishReason: 'tool_calls',
    responsesOutputItems: [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'read',
        arguments: '{"path":"a.txt"}',
      },
    ],
  })
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.botconnector.id/v1/responses')
  const body = JSON.parse(String(init.body))
  expect(body).toMatchObject({
    model: 'gpt-6-luna',
    stream: true,
    store: false,
    reasoning: { effort: 'high' },
    context_management: [{ type: 'compaction', compact_threshold: 240_000 }],
  })
  expect(body.input).toEqual([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: 'Checking.' },
    { type: 'function_call', call_id: 'old_call', name: 'glob', arguments: '{"pattern":"*"}' },
    { type: 'function_call_output', call_id: 'old_call', output: 'a.txt' },
  ])
  expect(body.tools).toEqual([
    {
      type: 'function',
      name: 'read',
      description: 'Read file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      strict: false,
    },
  ])
})

test('Luna Auto PTC omits programmatic marker for a single small read', async () => {
  const f = vi.fn(async () =>
    sse([
      {
        type: 'response.completed',
        response: { id: 'resp_small_direct', usage: { input_tokens: 10, output_tokens: 1 } },
      },
    ]),
  )
  const p = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test_key',
    model: 'gpt-6-luna',
    providerId: 'bc-cloud',
    fetch: f,
    enableProgrammaticToolCalling: true,
  })
  await p.chat({
    messages: [{ role: 'user', content: 'Read package.json and return only the version.' }],
    tools: [toolDef('read')],
  })
  const [, init] = f.mock.calls[0] as unknown as [string, RequestInit]
  const body = JSON.parse(String(init.body))
  expect(body.tools).toHaveLength(1)
  expect(body.tools[0].name).toBe('read')
  expect(body.tools[0].allowed_callers).toBeUndefined()
  expect(body.tools.some((tool: Record<string, unknown>) => tool.type === 'programmatic_tool_calling')).toBe(false)
})

test('Luna Auto PTC forces programmatic callers for deterministic aggregation', async () => {
  const f = vi.fn(async () =>
    sse([
      {
        type: 'response.completed',
        response: { id: 'resp_big_ptc', usage: { input_tokens: 10, output_tokens: 1 } },
      },
    ]),
  )
  const p = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test_key',
    model: 'gpt-6-luna',
    providerId: 'bc-cloud',
    fetch: f,
    enableProgrammaticToolCalling: true,
  })
  await p.chat({
    messages: [{ role: 'user', content: 'Compare all files, count matching records, and return the total.' }],
    tools: [toolDef('read'), toolDef('grep'), toolDef('bash')],
  })
  const [, init] = f.mock.calls[0] as unknown as [string, RequestInit]
  const body = JSON.parse(String(init.body))
  expect(body.tools.find((tool: Record<string, unknown>) => tool.name === 'read')?.allowed_callers).toEqual([
    'programmatic',
  ])
  expect(body.tools.find((tool: Record<string, unknown>) => tool.name === 'grep')?.allowed_callers).toEqual([
    'programmatic',
  ])
  expect(body.tools.find((tool: Record<string, unknown>) => tool.name === 'bash')?.allowed_callers).toBeUndefined()
  expect(body.tools.some((tool: Record<string, unknown>) => tool.type === 'programmatic_tool_calling')).toBe(true)
})

test('BotConnector non-Luna models remain on Chat Completions', async () => {
  const f = vi.fn(async () => sse([chunk({ content: 'ok' })]))
  const p = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test_key',
    model: 'glm-5.3-flash',
    providerId: 'bc-cloud',
    fetch: f,
  })
  expect((await p.chat({ messages: [{ role: 'user', content: 'hi' }] })).text).toBe('ok')
  const [url] = f.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.botconnector.id/v1/chat/completions')
})



test('Luna Responses WebSocket sends automatic compaction context management', async () => {
  type WsFactory = NonNullable<Parameters<typeof createProvider>[0]['responsesWebSocketFactory']>
  const sent: unknown[] = []
  const envelopes = [
    {
      done: false,
      value: {
        type: 'message',
        message: { type: 'response.created', response: { id: 'resp_ws_compact' } },
      },
    },
    {
      done: false,
      value: {
        type: 'message',
        message: {
          type: 'response.completed',
          response: { id: 'resp_ws_compact', usage: { input_tokens: 10, output_tokens: 2 } },
        },
      },
    },
  ]
  const wsFactory = vi.fn(
    () =>
      ({
        send(event: unknown) {
          sent.push(event)
        },
        stream() {
          let index = 0
          return {
            async next() {
              return envelopes[index++] ?? { done: true, value: undefined }
            },
            [Symbol.asyncIterator]() {
              return this
            },
          }
        },
        close() {},
      }) as unknown as ReturnType<WsFactory>,
  )
  const p = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test_key',
    model: 'gpt-6-luna',
    providerId: 'bc-cloud',
    fetch: vi.fn(),
    responsesWebSocketFactory: wsFactory,
  })

  await p.chat({ messages: [{ role: 'user', content: 'hi' }] })

  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    type: 'response.create',
    model: 'gpt-6-luna',
    store: false,
    context_management: [{ type: 'compaction', compact_threshold: 240_000 }],
  })
})

test('Luna Responses WebSocket falls back to HTTP SSE when the socket fails before output', async () => {
  type WsFactory = NonNullable<Parameters<typeof createProvider>[0]['responsesWebSocketFactory']>
  const wsFactory = vi.fn(
    () =>
      ({
        send() {
          throw new Error('WebSocket connection failed')
        },
        stream() {
          return {
            async next() {
              return { done: true, value: undefined }
            },
            [Symbol.asyncIterator]() {
              return this
            },
          }
        },
        close() {},
      }) as unknown as ReturnType<WsFactory>,
  )
  const f = vi.fn(async () =>
    sse([
      { type: 'response.output_text.delta', delta: 'FALLBACK_OK' },
      {
        type: 'response.completed',
        response: { id: 'resp_http', usage: { input_tokens: 11, output_tokens: 4 } },
      },
    ]),
  )
  const p = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test_key',
    model: 'gpt-6-luna',
    providerId: 'bc-cloud',
    fetch: f,
    responsesWebSocketFactory: wsFactory,
  })
  const deltas: string[] = []
  const completion = await p.chat({
    messages: [{ role: 'user', content: 'hi' }],
    onText: (delta) => deltas.push(delta),
  })

  expect(completion.text).toBe('FALLBACK_OK')
  expect(completion.usage).toEqual({ inputTokens: 11, outputTokens: 4 })
  expect(deltas).toEqual(['FALLBACK_OK'])
  expect(wsFactory).toHaveBeenCalledTimes(2)
  expect(f).toHaveBeenCalledTimes(1)
  const [fallbackUrl, fallbackInit] = f.mock.calls[0] as unknown as [string, RequestInit]
  expect(fallbackUrl).toBe('https://api.botconnector.id/v1/responses')
  expect(JSON.parse(String(fallbackInit.body))).toMatchObject({
    context_management: [{ type: 'compaction', compact_threshold: 240_000 }],
  })
})

test('Luna Responses WebSocket does not replay through HTTP after partial text was emitted', async () => {
  type WsFactory = NonNullable<Parameters<typeof createProvider>[0]['responsesWebSocketFactory']>
  const envelopes = [
    {
      done: false,
      value: {
        type: 'message',
        message: { type: 'response.output_text.delta', delta: 'PARTIAL' },
      },
    },
    {
      done: false,
      value: { type: 'close', code: 1006, reason: 'network lost' },
    },
  ]
  const wsFactory = vi.fn(
    () =>
      ({
        send() {},
        stream() {
          let index = 0
          return {
            async next() {
              return envelopes[index++] ?? { done: true, value: undefined }
            },
            [Symbol.asyncIterator]() {
              return this
            },
          }
        },
        close() {},
      }) as unknown as ReturnType<WsFactory>,
  )
  const f = vi.fn(async () => sse([{ type: 'response.output_text.delta', delta: 'SHOULD_NOT_RUN' }]))
  const p = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test_key',
    model: 'gpt-6-luna',
    providerId: 'bc-cloud',
    fetch: f,
    responsesWebSocketFactory: wsFactory,
  })
  const deltas: string[] = []

  await expect(
    p.chat({
      messages: [{ role: 'user', content: 'hi' }],
      onText: (delta) => deltas.push(delta),
    }),
  ).rejects.toBeInstanceOf(ProviderError)

  expect(deltas).toEqual(['PARTIAL'])
  expect(f).not.toHaveBeenCalled()
})

test('Luna PTC WebSocket reconnect full-replays program fingerprint and caller after previous_response_not_found', async () => {
  type WsFactory = NonNullable<Parameters<typeof createProvider>[0]['responsesWebSocketFactory']>
  const caller = { type: 'program' as const, caller_id: 'call_prog_1' }
  const sent: Record<string, unknown>[] = []
  let factoryIndex = 0

  const firstEvents = [
    {
      done: false,
      value: { type: 'message', message: { type: 'response.created', response: { id: 'resp_ptc_1' } } },
    },
    {
      done: false,
      value: {
        type: 'message',
        message: {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'program',
            id: 'prog_1',
            call_id: 'call_prog_1',
            code: 'const x = await tools.read({path:"a.txt"}); text(x);',
            fingerprint: 'opaque_fp_1',
          },
        },
      },
    },
    {
      done: false,
      value: {
        type: 'message',
        message: {
          type: 'response.output_item.done',
          output_index: 1,
          item: {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_child_1',
            name: 'read',
            arguments: '{"path":"a.txt"}',
            caller,
            status: 'completed',
          },
        },
      },
    },
    {
      done: false,
      value: {
        type: 'message',
        message: {
          type: 'response.completed',
          response: { id: 'resp_ptc_1', usage: { input_tokens: 50, output_tokens: 10 } },
        },
      },
    },
    {
      done: false,
      value: {
        type: 'message',
        message: {
          type: 'error',
          status: 404,
          error: { code: 'previous_response_not_found', message: 'previous response lost' },
        },
      },
    },
  ]

  const retryEvents = [
    {
      done: false,
      value: { type: 'message', message: { type: 'response.created', response: { id: 'resp_ptc_2' } } },
    },
    {
      done: false,
      value: { type: 'message', message: { type: 'response.output_text.delta', delta: 'DONE' } },
    },
    {
      done: false,
      value: {
        type: 'message',
        message: {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'DONE', annotations: [], logprobs: [] }],
          },
        },
      },
    },
    {
      done: false,
      value: {
        type: 'message',
        message: {
          type: 'response.completed',
          response: { id: 'resp_ptc_2', usage: { input_tokens: 80, output_tokens: 4 } },
        },
      },
    },
  ]

  const wsFactory = vi.fn(
    () => {
      const events = factoryIndex++ === 0 ? firstEvents : retryEvents
      let index = 0
      return {
        send(event: unknown) {
          sent.push(structuredClone(event) as Record<string, unknown>)
        },
        stream() {
          return {
            async next() {
              return events[index++] ?? { done: true, value: undefined }
            },
            [Symbol.asyncIterator]() {
              return this
            },
          }
        },
        close() {},
      } as unknown as ReturnType<WsFactory>
    },
  )

  const p = createProvider({
    baseURL: 'https://api.botconnector.id/v1',
    apiKey: 'bc_live_test_key',
    model: 'gpt-6-luna',
    providerId: 'bc-cloud',
    responsesWebSocketFactory: wsFactory,
    enableProgrammaticToolCalling: true,
  })

  const user: ChatMessage = { role: 'user', content: 'inspect a.txt' }
  const first = await p.chat({ messages: [user], tools: [toolDef('read')] })
  expect(first.toolCalls).toEqual([
    { id: 'call_child_1', name: 'read', arguments: '{"path":"a.txt"}', caller },
  ])
  expect(first.responsesOutputItems?.find((item) => item.type === 'program')).toMatchObject({
    call_id: 'call_prog_1',
    fingerprint: 'opaque_fp_1',
  })

  const history: ChatMessage[] = [
    user,
    completionAssistantMessage(first),
    {
      role: 'tool',
      tool_call_id: 'call_child_1',
      content: 'hello',
      responses_caller: caller,
    },
  ]
  const second = await p.chat({ messages: history, tools: [toolDef('read')] })
  expect(second.text).toBe('DONE')
  expect(sent).toHaveLength(3)

  expect(sent[1]).toMatchObject({
    previous_response_id: 'resp_ptc_1',
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_child_1',
        output: 'hello',
        caller,
      },
    ],
  })

  expect(sent[2].previous_response_id).toBeUndefined()
  expect(sent[2].input).toEqual([
    { role: 'user', content: 'inspect a.txt' },
    {
      type: 'program',
      id: 'prog_1',
      call_id: 'call_prog_1',
      code: 'const x = await tools.read({path:"a.txt"}); text(x);',
      fingerprint: 'opaque_fp_1',
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
    {
      type: 'function_call_output',
      call_id: 'call_child_1',
      output: 'hello',
      caller,
    },
  ])
})

test('Responses WebSocket continuation sends only new tool output after the previous assistant response', () => {
  const requestMessages: ChatMessage[] = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'read a.txt' },
  ]
  const completion: Completion = {
    text: '',
    toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' }],
    finishReason: 'tool_calls',
  }
  const current: ChatMessage[] = [
    ...requestMessages,
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'hello' },
  ]

  expect(
    responseContinuationInput(current, {
      responseId: 'resp_1',
      requestMessages,
      completion,
    }),
  ).toEqual({
    previousResponseId: 'resp_1',
    incremental: true,
    input: [{ type: 'function_call_output', call_id: 'call_1', output: 'hello' }],
  })
})

test('Responses WebSocket continues a PTC program_output-only response with empty incremental input', () => {
  const requestMessages: ChatMessage[] = [{ role: 'user', content: 'aggregate' }]
  const completion: Completion = {
    text: '',
    toolCalls: [],
    finishReason: 'continue',
    responsesOutputItems: [
      {
        type: 'program_output',
        id: 'prog_out_1',
        call_id: 'call_prog_1',
        result: '{"ok":true}',
        status: 'completed',
      },
    ] as unknown as ResponseOutputItem[],
  }
  const current: ChatMessage[] = [
    ...requestMessages,
    {
      role: 'assistant',
      content: null,
      responses_output_items: completion.responsesOutputItems,
    },
  ]

  expect(
    responseContinuationInput(current, {
      responseId: 'resp_program_output',
      requestMessages,
      completion,
    }),
  ).toEqual({
    previousResponseId: 'resp_program_output',
    incremental: true,
    input: [],
  })
})

test('Responses WebSocket continuation sends only the next user message after a completed answer', () => {
  const requestMessages: ChatMessage[] = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'first' },
  ]
  const completion: Completion = { text: 'FIRST_OK', toolCalls: [], finishReason: 'stop' }
  const current: ChatMessage[] = [
    ...requestMessages,
    { role: 'assistant', content: 'FIRST_OK' },
    { role: 'user', content: 'second' },
  ]

  const plan = responseContinuationInput(current, {
    responseId: 'resp_2',
    requestMessages,
    completion,
  })
  expect(plan.previousResponseId).toBe('resp_2')
  expect(plan.incremental).toBe(true)
  expect(plan.input).toEqual([{ role: 'user', content: 'second' }])
})

test('Responses WebSocket continuation replays full context when local history diverges', () => {
  const requestMessages: ChatMessage[] = [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'first' },
  ]
  const completion: Completion = { text: 'FIRST_OK', toolCalls: [], finishReason: 'stop' }
  const current: ChatMessage[] = [
    { role: 'system', content: 'CHANGED SYS' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'FIRST_OK' },
    { role: 'user', content: 'second' },
  ]

  const plan = responseContinuationInput(current, {
    responseId: 'resp_old',
    requestMessages,
    completion,
  })
  expect(plan.previousResponseId).toBeUndefined()
  expect(plan.incremental).toBe(false)
  expect(plan.input).toEqual([
    { role: 'system', content: 'CHANGED SYS' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'FIRST_OK' },
    { role: 'user', content: 'second' },
  ])
})
