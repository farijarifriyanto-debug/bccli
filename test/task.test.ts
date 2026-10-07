import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { Agent, type AgentEvent } from '../src/agent'
import { BUILTIN_AGENTS } from '../src/agents'
import { Permissions } from '../src/permissions'
import type { ChatRequest, Completion, Provider } from '../src/provider'
import { ALL_TOOLS } from '../src/tools/index'
import { createTaskTool } from '../src/tools/task'

function router(scripts: Record<string, Completion[]>, requests: ChatRequest[] = []): Provider {
  return {
    async chat(req) {
      requests.push(req)
      const sys = String(req.messages[0].content)
      const key = Object.keys(scripts).find((k) => k !== 'PARENT' && sys.includes(k)) ?? 'PARENT'
      const next = scripts[key].shift()
      if (!next) throw new Error(`script ${key} exhausted`)
      return next
    },
    async listModels() {
      return []
    },
  }
}
const call = (name: string, args: object, id: string) => ({ id, name, arguments: JSON.stringify(args) })

function setup(scripts: Record<string, Completion[]>, extraAgents = [] as typeof BUILTIN_AGENTS) {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-task-'))
  writeFileSync(join(cwd, 'auth.ts'), 'export function login() {}\n')
  const requests: ChatRequest[] = []
  const provider = router(scripts, requests)
  const permissions = new Permissions('default', [], cwd)
  const task = createTaskTool({
    agents: [...BUILTIN_AGENTS, ...extraAgents],
    baseTools: () => ALL_TOOLS,
    permissions,
    provider: () => provider,
    providerFor: (ref) => {
      if (ref.startsWith('nope/')) throw new Error('Provider "nope" tidak ada di config.')
      return provider
    },
    systemPrompt: 'PARENT-SYSTEM',
    cwd,
  })
  const events: AgentEvent[] = []
  const agent = new Agent({ provider, tools: [...ALL_TOOLS, task], permissions, systemPrompt: 'PARENT-SYSTEM', cwd })
  agent.onEvent = (e) => events.push(e)
  return { agent, events, requests, cwd }
}

test('explore runs read-only in a fresh context and only its answer returns', async () => {
  const { agent, events, requests } = setup({
    PARENT: [{ text: '', toolCalls: [call('task', { agent: 'explore', description: 'cari login', prompt: 'find login' }, 't1')] }, { text: 'done', toolCalls: [] }],
    'read-only research agent': [
      { text: '', toolCalls: [call('grep', { pattern: 'login' }, 'g1')] },
      { text: 'login ada di auth.ts:1', toolCalls: [] },
    ],
  })
  await agent.run('where is login?', new AbortController().signal)
  const childFirst = requests.find((r) => String(r.messages[0].content).includes('read-only research agent'))!
  expect(childFirst.messages.filter((m) => m.role === 'user')).toEqual([{ role: 'user', content: 'find login' }])
  expect(childFirst.tools?.map((t) => t.function.name)).toEqual(['read', 'grep', 'glob'])
  const parentSecond = requests.at(-1)!
  const toolMsg = parentSecond.messages.find((m) => m.role === 'tool') as { content: string }
  expect(toolMsg.content).toBe('login ada di auth.ts:1')
  expect(parentSecond.messages.some((m) => m.role === 'tool' && String(m.content).includes('export function login'))).toBe(false)
  expect(events.some((e) => e.type === 'subagent' && e.parentId === 't1' && e.event.type === 'toolStart')).toBe(true)
})

test('general asks permission with its label, and children cannot spawn tasks', async () => {
  const { agent, requests } = setup({
    PARENT: [{ text: '', toolCalls: [call('task', { agent: 'general', description: 'buat file', prompt: 'write x' }, 't1')] }, { text: 'ok', toolCalls: [] }],
    'delegated task': [{ text: '', toolCalls: [call('write', { path: 'x.txt', content: 'x' }, 'w1')] }, { text: 'written', toolCalls: [] }],
  })
  const asks: (string | undefined)[] = []
  agent.askPermission = async (req) => {
    asks.push(req.agent)
    return 'yes'
  }
  await agent.run('go', new AbortController().signal)
  expect(asks).toEqual(['general'])
  const child = requests.find((r) => String(r.messages[0].content).includes('delegated task'))!
  expect(child.tools?.map((t) => t.function.name)).not.toContain('task')
})

test('unknown agent, unknown tools in a custom agent, and unknown provider are error results', async () => {
  const { agent, requests } = setup(
    {
      PARENT: [
        {
          text: '',
          toolCalls: [
            call('task', { agent: 'ghost', description: 'x', prompt: 'x' }, 'a'),
            call('task', { agent: 'weird', description: 'x', prompt: 'x' }, 'b'),
            call('task', { agent: 'far', description: 'x', prompt: 'x' }, 'c'),
          ],
        },
        { text: 'ok', toolCalls: [] },
      ],
    },
    [
      { name: 'weird', description: 'w', tools: ['teleport'], prompt: 'p' },
      { name: 'far', description: 'f', model: 'nope/x', prompt: 'p' },
    ],
  )
  await agent.run('go', new AbortController().signal)
  const results = requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
  expect(results[0]).toMatch(/Agent "ghost" does not exist/)
  expect(results[1]).toMatch(/unknown tools: teleport/)
  expect(results[2]).toMatch(/Provider "nope"/)
})

test('parallel explore tasks run concurrently', async () => {
  let active = 0
  let peak = 0
  const slow: Provider = {
    async chat(req) {
      const sys = String(req.messages[0].content)
      if (sys.includes('read-only research agent')) {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 100))
        active--
        return { text: 'found', toolCalls: [] }
      }
      const hasResults = req.messages.some((m) => m.role === 'tool')
      return hasResults
        ? { text: 'done', toolCalls: [] }
        : {
            text: '',
            toolCalls: [call('task', { agent: 'explore', description: 'a', prompt: 'a' }, 'p1'), call('task', { agent: 'explore', description: 'b', prompt: 'b' }, 'p2')],
          }
    },
    async listModels() {
      return []
    },
  }
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-par-'))
  const permissions = new Permissions('default', [], cwd)
  const task = createTaskTool({ agents: BUILTIN_AGENTS, baseTools: () => ALL_TOOLS, permissions, provider: () => slow, providerFor: () => slow, systemPrompt: 'S', cwd })
  const agent = new Agent({ provider: slow, tools: [...ALL_TOOLS, task], permissions, systemPrompt: 'S', cwd })
  await agent.run('x', new AbortController().signal)
  expect(peak).toBe(2)
  expect(agent.messages.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(['p1', 'p2'])
})

test('a custom agent overriding explore with non-read tools is not run in parallel', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-ovr-'))
  const provider = router({ PARENT: [] })
  const permissions = new Permissions('default', [], cwd)
  const task = createTaskTool({
    agents: [...BUILTIN_AGENTS, { name: 'explore', description: 'x', tools: ['bash'], prompt: 'p' }],
    baseTools: () => ALL_TOOLS,
    permissions,
    provider: () => provider,
    providerFor: () => provider,
    systemPrompt: 'S',
    cwd,
  })
  expect(task.parallelSafe?.({ agent: 'explore', description: 'a', prompt: 'a' })).toBe(false)
  const readOnly = createTaskTool({ agents: BUILTIN_AGENTS, baseTools: () => ALL_TOOLS, permissions, provider: () => provider, providerFor: () => provider, systemPrompt: 'S', cwd })
  expect(readOnly.parallelSafe?.({ agent: 'explore', description: 'a', prompt: 'a' })).toBe(true)
})

test('subagents never get exit_plan', async () => {
  const requests: ChatRequest[] = []
  const provider = router(
    {
      PARENT: [{ text: '', toolCalls: [call('task', { agent: 'general', description: 'x', prompt: 'x' }, 't1')] }, { text: 'ok', toolCalls: [] }],
      'delegated task': [{ text: 'done', toolCalls: [] }],
    },
    requests,
  )
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-ep-'))
  const permissions = new Permissions('default', [], cwd)
  const exitPlan = { ...ALL_TOOLS[0], name: 'exit_plan' }
  let agent: Agent | undefined
  // Same wiring as setup.ts: subagents take the main agent's current tools.
  const task = createTaskTool({ agents: BUILTIN_AGENTS, baseTools: () => agent!.tools, permissions, provider: () => provider, providerFor: () => provider, systemPrompt: 'S', cwd })
  agent = new Agent({ provider, tools: [...ALL_TOOLS, exitPlan, task], permissions, systemPrompt: 'S', cwd })
  await agent.run('go', new AbortController().signal)
  const child = requests.find((r) => String(r.messages[0].content).includes('delegated task'))!
  expect(child.tools?.map((t) => t.function.name)).not.toContain('exit_plan')
})

test('subagent file writes go through the parent checkpoint hook (undoable)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-task-ck-'))
  const provider = router({ PARENT: [{ text: '', toolCalls: [call('write', { path: 'n.txt', content: 'x' }, 'w1')] }, { text: 'ok', toolCalls: [] }] })
  const task = createTaskTool({
    agents: BUILTIN_AGENTS,
    baseTools: () => ALL_TOOLS,
    permissions: new Permissions('allowAll', [], cwd),
    provider: () => provider,
    providerFor: () => provider,
    systemPrompt: 'S',
    cwd,
  })
  const seen: string[] = []
  await task.run(
    { agent: 'general', description: 'tulis', prompt: 'tulis n.txt' },
    { cwd, signal: new AbortController().signal, readFiles: new Set(), checkpoint: async (p) => void seen.push(p) },
  )
  expect(seen).toEqual([join(cwd, 'n.txt')])
})


test('subagents inherit the parent reasoning preference', async () => {
  const requests: ChatRequest[] = []
  const provider = router(
    {
      PARENT: [{ text: '', toolCalls: [call('task', { agent: 'explore', description: 'cek', prompt: 'cek' }, 't1')] }, { text: 'done', toolCalls: [] }],
      'read-only research agent': [{ text: 'found', toolCalls: [] }],
    },
    requests,
  )
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-task-reasoning-'))
  const permissions = new Permissions('default', [], cwd)
  const task = createTaskTool({
    agents: BUILTIN_AGENTS,
    baseTools: () => ALL_TOOLS,
    permissions,
    provider: () => provider,
    providerFor: () => provider,
    systemPrompt: 'S',
    cwd,
    reasoning: () => 'high',
  })
  const agent = new Agent({ provider, tools: [...ALL_TOOLS, task], permissions, systemPrompt: 'PARENT-SYSTEM', cwd, reasoning: 'high' })
  await agent.run('go', new AbortController().signal)
  const child = requests.find((r) => String(r.messages[0].content).includes('read-only research agent'))!
  expect(child.reasoning).toBe('high')
})

test('subagent resolves the parent system prompt at run time', async () => {
  const requests: ChatRequest[] = []
  const provider = router({ PARENT: [{ text: 'done', toolCalls: [] }] }, requests)
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-task-dynamic-system-'))
  const permissions = new Permissions('default', [], cwd)
  let parentSystem = 'MODEL old'
  const task = createTaskTool({
    agents: BUILTIN_AGENTS,
    baseTools: () => ALL_TOOLS,
    permissions,
    provider: () => provider,
    providerFor: () => provider,
    systemPrompt: () => parentSystem,
    cwd,
  })

  parentSystem = 'MODEL bc-cloud/mimo-v2.6-flash'
  await task.run(
    { agent: 'explore', description: 'cek model', prompt: 'laporkan model' },
    { cwd, signal: new AbortController().signal, readFiles: new Set() },
  )

  const system = String(requests[0]?.messages[0]?.content)
  expect(system).toContain('MODEL bc-cloud/mimo-v2.6-flash')
  expect(system).not.toContain('MODEL old')
})

test('subagent system prompt reports its own model override', async () => {
  const requests: ChatRequest[] = []
  const provider = router({ PARENT: [{ text: 'done', toolCalls: [] }] }, requests)
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-task-model-override-'))
  const task = createTaskTool({
    agents: [{ name: 'special', description: 'special', model: 'bc-cloud/mimo-v2.6-flash', prompt: 'special role' }],
    baseTools: () => ALL_TOOLS,
    permissions: new Permissions('default', [], cwd),
    provider: () => provider,
    providerFor: () => provider,
    systemPrompt: (modelRef) => `MODEL ${modelRef ?? 'parent'}`,
    cwd,
  })

  await task.run(
    { agent: 'special', description: 'cek model', prompt: 'laporkan model' },
    { cwd, signal: new AbortController().signal, readFiles: new Set() },
  )

  const system = String(requests[0]?.messages[0]?.content)
  expect(system).toContain('MODEL bc-cloud/mimo-v2.6-flash')
  expect(system).not.toContain('MODEL parent')
})

test('builtin agents declare step caps', () => {
  expect(BUILTIN_AGENTS.map((a) => ({ name: a.name, maxSteps: a.maxSteps }))).toEqual([
    { name: 'explore', maxSteps: 30 },
    { name: 'general', maxSteps: 50 },
  ])
})

test('a subagent without its own maxSteps stops at the builtin cap', async () => {
  const forever = Array.from({ length: 35 }, (_, i) => ({ text: '', toolCalls: [call('grep', { pattern: `p${i}` }, `g${i}`)] }) as Completion)
  const { agent, events } = setup({
    PARENT: [
      { text: '', toolCalls: [call('task', { agent: 'explore', description: 'loop', prompt: 'scan' }, 't1')] },
      { text: 'ok', toolCalls: [] },
    ],
    'read-only research agent': forever,
  })
  await agent.run('go', new AbortController().signal)
  const limit = events.find((e) => e.type === 'subagent' && e.event.type === 'stepLimit')
  expect(limit).toBeDefined()
  expect((limit as { event: { maxSteps: number } }).event.maxSteps).toBe(30)
})

test('a custom agent with no maxSteps gets the default subagent cap', async () => {
  const forever = Array.from({ length: 55 }, (_, i) => ({ text: '', toolCalls: [call('grep', { pattern: `p${i}` }, `g${i}`)] }) as Completion)
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-task-cap-'))
  const requests: ChatRequest[] = []
  const provider = router(
    {
      PARENT: [
        { text: '', toolCalls: [call('task', { agent: 'crawler', description: 'loop', prompt: 'scan' }, 't1')] },
        { text: 'ok', toolCalls: [] },
      ],
      'custom role': forever,
    },
    requests,
  )
  const task = createTaskTool({
    agents: [{ name: 'crawler', description: 'c', tools: ['grep'], prompt: 'custom role' }],
    baseTools: () => ALL_TOOLS,
    permissions: new Permissions('default', [], cwd),
    provider: () => provider,
    providerFor: () => provider,
    systemPrompt: 'S',
    cwd,
  })
  const events: AgentEvent[] = []
  const agent = new Agent({ provider, tools: [...ALL_TOOLS, task], permissions: new Permissions('default', [], cwd), systemPrompt: 'S', cwd })
  agent.onEvent = (e) => events.push(e)
  await agent.run('go', new AbortController().signal)
  const limit = events.find((e) => e.type === 'subagent' && e.event.type === 'stepLimit')
  expect(limit).toBeDefined()
  expect((limit as { event: { maxSteps: number } }).event.maxSteps).toBe(50)
})

test('parallel: true lets a write-capable agent run concurrently with its sibling', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-parflag-'))
  const permissions = new Permissions('default', [], cwd)
  const provider = router({})
  const task = createTaskTool({
    agents: [
      ...BUILTIN_AGENTS,
      { name: 'writer', description: 'writes files', prompt: 'p', tools: ['write', 'bash'], parallel: true },
    ],
    baseTools: () => ALL_TOOLS,
    permissions,
    provider: () => provider,
    providerFor: () => provider,
    systemPrompt: 'S',
    cwd,
  })
  expect(task.parallelSafe?.({ agent: 'writer', description: 'a', prompt: 'a' })).toBe(true)
  expect(task.parallelSafe?.({ agent: 'general', description: 'a', prompt: 'a' })).toBe(false)
})

test('concurrent write subagents queue their permission prompts one at a time', async () => {
  const { agent } = setup(
    {
      PARENT: [
        {
          text: '',
          toolCalls: [
            call('task', { agent: 'writerA', description: 'a', prompt: 'write task a' }, 't1'),
            call('task', { agent: 'writerB', description: 'b', prompt: 'write task b' }, 't2'),
          ],
        },
        { text: 'ok', toolCalls: [] },
      ],
      'write task a': [
        { text: '', toolCalls: [call('write', { path: 'a.txt', content: 'A' }, 'w1')] },
        { text: 'done a', toolCalls: [] },
      ],
      'write task b': [
        { text: '', toolCalls: [call('write', { path: 'b.txt', content: 'B' }, 'w2')] },
        { text: 'done b', toolCalls: [] },
      ],
    },
    [
      { name: 'writerA', description: 'a', prompt: 'write task a', tools: ['write'], parallel: true },
      { name: 'writerB', description: 'b', prompt: 'write task b', tools: ['write'], parallel: true },
    ],
  )
  let active = 0
  let maxActive = 0
  let asks = 0
  agent.askPermission = async () => {
    asks++
    active++
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 25))
    active--
    return 'yes'
  }
  await agent.run('do both', new AbortController().signal)
  expect(asks).toBe(2)
  expect(maxActive).toBe(1)
  expect(agent.messages.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id)).toEqual(['t1', 't2'])
})
