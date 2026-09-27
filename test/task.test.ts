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
  expect(results[0]).toMatch(/Agent "ghost" tidak ada/)
  expect(results[1]).toMatch(/alat tidak dikenal: teleport/)
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
