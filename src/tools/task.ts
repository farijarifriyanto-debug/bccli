import { z } from 'zod'
import { Agent, type AgentEvent } from '../agent'
import type { AgentDef } from '../extensions'
import type { Permissions } from '../permissions'
import type { Provider } from '../provider'
import type { ReasoningLevel } from '../reasoning'
import { defineTool, type Tool } from './types'
import type { HooksConfig } from '../hooks'
import { t } from '../i18n'

type TaskToolOptionsPluginEmit = (event: 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'Stop', payload?: { tool?: string; input?: unknown; output?: string }) => Promise<void>

export interface TaskToolOptions {
  agents: AgentDef[]
  baseTools: () => Tool[]
  permissions: Permissions
  provider: () => Provider
  providerFor: (modelRef: string) => Provider
  systemPrompt: string | ((modelRef?: string) => string)
  cwd: string
  reasoning?: () => ReasoningLevel
  /** Inherited by subagents so their tool calls fire the same hooks as the main agent. */
  hooks?: HooksConfig
  /** Inherited by subagents so their tool calls fire the same plugin observers as the main agent. */
  pluginEmit?: TaskToolOptionsPluginEmit
  env?: NodeJS.ProcessEnv
}

export function createTaskTool(opts: TaskToolOptions): Tool {
  const byName = new Map(opts.agents.map((a) => [a.name, a]))
  const list = opts.agents.map((a) => `- ${a.name}: ${a.description}`).join('\n')
  // Parallel children share one single-slot prompt UI: permission dialogs must not interleave.
  let askChain: Promise<unknown> = Promise.resolve()
  const enqueueAsk = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = askChain.then(
      () => fn(),
      () => fn(),
    )
    askChain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
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
    // parallel: true opts a write-capable agent in; otherwise only all-read agents run concurrently
    // (a project file may redefine "explore").
    parallelSafe: (input) => {
      const def = byName.get(input.agent)
      if (def?.parallel) return true
      if (!def?.tools) return false
      const base = opts.baseTools()
      return def.tools.every((name) => base.find((t) => t.name === name)?.kind === 'read')
    },
    async run(input, ctx) {
      const def = byName.get(input.agent)
      if (!def) return { output: `Agent "${input.agent}" does not exist. Available: ${[...byName.keys()].join(', ')}`, isError: true }
      // No nesting, and plan approval stays with the main agent.
      const base = opts.baseTools().filter((t) => t.name !== 'task' && t.name !== 'exit_plan')
      const unknown = (def.tools ?? []).filter((n) => !base.some((t) => t.name === n))
      if (unknown.length) return { output: `Agent "${def.name}": unknown tools: ${unknown.join(', ')}`, isError: true }
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
        systemPrompt: `${typeof opts.systemPrompt === 'function' ? opts.systemPrompt(def.model) : opts.systemPrompt}\n\n# Your role\n${def.prompt}`,
        cwd: opts.cwd,
        // Every subagent runs with a step cap so a looping child cannot burn tokens forever.
        maxSteps: def.maxSteps ?? 50,
        label: def.name,
        reasoning: opts.reasoning?.() ?? 'auto',
        hooks: opts.hooks,
        pluginEmit: opts.pluginEmit,
        env: opts.env,
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
      const ask = ctx.ask
      if (ask) child.askPermission = (req) => enqueueAsk(() => ask(req))
      await child.run(input.prompt, ctx.signal)
      ctx.addUsage?.(child.totalUsage)
      const tokens = child.totalUsage.inputTokens + child.totalUsage.outputTokens
      const display = t('{steps} steps · {tokens} tokens', { steps, tokens: tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : tokens })
      if (outcome?.type === 'error') return { output: `Subagent ${def.name} failed: ${outcome.message}`, isError: true, display }
      if (outcome?.type === 'aborted') return { output: `Subagent ${def.name} was cancelled.`, isError: true, display }
      const last = [...child.messages].reverse().find((m) => m.role === 'assistant' && m.content)
      const report = last && typeof last.content === 'string' ? last.content : '(no report)'
      const suffix = outcome?.type === 'stepLimit' ? `\n\n(The subagent stopped at its ${outcome.maxSteps}-step limit.)` : ''
      return { output: report + suffix, display }
    },
  }) as Tool
}
