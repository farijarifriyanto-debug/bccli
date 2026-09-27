import { z } from 'zod'
import { Agent, type AgentEvent } from '../agent'
import type { AgentDef } from '../extensions'
import type { Permissions } from '../permissions'
import type { Provider } from '../provider'
import { defineTool, type Tool } from './types'

export interface TaskToolOptions {
  agents: AgentDef[]
  baseTools: () => Tool[]
  permissions: Permissions
  provider: () => Provider
  providerFor: (modelRef: string) => Provider
  systemPrompt: string
  cwd: string
}

export function createTaskTool(opts: TaskToolOptions): Tool {
  const byName = new Map(opts.agents.map((a) => [a.name, a]))
  const list = opts.agents.map((a) => `- ${a.name}: ${a.description}`).join('\n')
  return defineTool({
    name: 'task',
    description: `Delegate a self-contained sub-task to a subagent. It starts with an empty context and returns only its final report. Available agents:\n${list}`,
    schema: z.object({
      agent: z.string().describe('Agent name'),
      description: z.string().describe('3-6 word summary shown to the user'),
      prompt: z.string().describe('Full instructions; the subagent sees nothing else'),
    }),
    kind: 'read',
    target: (input) => `[${input.agent}] ${input.description}`,
    // Parallel only when the resolved agent can do nothing but read (a project file may redefine "explore").
    parallelSafe: (input) => {
      const allowed = byName.get(input.agent)?.tools
      if (!allowed) return false
      const base = opts.baseTools()
      return allowed.every((name) => base.find((t) => t.name === name)?.kind === 'read')
    },
    async run(input, ctx) {
      const def = byName.get(input.agent)
      if (!def) return { output: `Agent "${input.agent}" tidak ada. Tersedia: ${[...byName.keys()].join(', ')}`, isError: true }
      // No nesting, and plan approval stays with the main agent.
      const base = opts.baseTools().filter((t) => t.name !== 'task' && t.name !== 'exit_plan')
      const unknown = (def.tools ?? []).filter((n) => !base.some((t) => t.name === n))
      if (unknown.length) return { output: `Agent "${def.name}": alat tidak dikenal: ${unknown.join(', ')}`, isError: true }
      const allowed = def.tools
      const tools = allowed ? base.filter((t) => allowed.includes(t.name)) : base
      let provider: Provider
      try {
        provider = def.model ? opts.providerFor(def.model) : opts.provider()
      } catch (error) {
        return { output: `Agent "${def.name}": ${(error as Error).message}`, isError: true }
      }
      const child = new Agent({
        provider,
        tools,
        permissions: opts.permissions,
        systemPrompt: `${opts.systemPrompt}\n\n# Your role\n${def.prompt}`,
        cwd: opts.cwd,
        maxSteps: def.maxSteps ?? 50,
        label: def.name,
        // Subagent edits belong to the parent's turn so /undo reverts them too.
        checkpoint: ctx.checkpoint,
      })
      let outcome: AgentEvent | undefined
      let steps = 0
      child.onEvent = (event) => {
        if (event.type === 'toolStart') steps++
        if (event.type === 'error' || event.type === 'stepLimit' || event.type === 'aborted' || event.type === 'done') outcome = event
        if (event.type !== 'usage' && ctx.callId) ctx.emit?.({ type: 'subagent', parentId: ctx.callId, agent: def.name, event })
      }
      if (ctx.ask) child.askPermission = ctx.ask
      await child.run(input.prompt, ctx.signal)
      ctx.addUsage?.(child.totalUsage)
      const tokens = child.totalUsage.inputTokens + child.totalUsage.outputTokens
      const display = `${steps} langkah · ${tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens} token`
      if (outcome?.type === 'error') return { output: `Subagent ${def.name} gagal: ${outcome.message}`, isError: true, display }
      if (outcome?.type === 'aborted') return { output: `Subagent ${def.name} dibatalkan.`, isError: true, display }
      const last = [...child.messages].reverse().find((m) => m.role === 'assistant' && m.content)
      const report = last && typeof last.content === 'string' ? last.content : '(tidak ada laporan)'
      const suffix = outcome?.type === 'stepLimit' ? `\n\n(Subagent berhenti di batas ${def.maxSteps ?? 50} langkah.)` : ''
      return { output: report + suffix, display }
    },
  }) as Tool
}
