import type { PermissionRequest, Permissions } from './permissions'
import { completionAssistantMessage, hasPendingProgrammaticReplay, imageUserMessage, type ChatMessage, type Provider, type ToolCall, type Usage } from './provider'
import type { ReasoningLevel } from './reasoning'
import { recoverTextToolCalls } from './textToolCalls'
import { runHooks, type HookEvent, type HooksConfig } from './hooks'
import { type ToolDefinition, toolDefinitions } from './tools/index'
import type { ImageAttachment, Tool, ToolContext, ToolResult } from './tools/types'
import { pruneOldFetches, WebBudget } from './webBudget'
import { ABORTED, raceAbort } from './abort'
import { t } from './i18n'
import { estimateMessages, estimateTokens, trimToFit } from './tokenBudget'

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'textReplace'; text: string }
  | { type: 'toolStart'; id: string; tool: string; target: string }
  | { type: 'toolEnd'; id: string; tool: string; output: string; display?: string; isError: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheWriteTokens?: number }
  | { type: 'compacted' }
  | { type: 'stepLimit'; maxSteps: number }
  | { type: 'aborted' }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'subagent'; parentId: string; agent: string; event: AgentEvent }

export type PermissionAnswer = 'yes' | 'session' | 'all' | 'no'
export type PermissionAsk = PermissionRequest & { preview?: string; sessionRules?: string[]; agent?: string }
export type AskPermission = (req: PermissionAsk) => Promise<PermissionAnswer>

/** What a tool call returns to the loop: text for the tool message plus optional image attachments. */
interface ToolOutcome {
  output: string
  images?: ImageAttachment[]
}

export interface AgentOptions {
  provider: Provider
  tools: Tool[]
  permissions: Permissions
  systemPrompt: string
  cwd: string
  history?: ChatMessage[]
  maxSteps?: number | null
  contextWindow?: number
  onMessage?: (message: ChatMessage) => void
  onReset?: () => void
  /** Marks the start of a user turn (undo boundary). */
  onTurnStart?: () => void
  checkpoint?: (absPath: string) => Promise<void>
  /** Subagent name, shown on its permission prompts. */
  label?: string
  reasoning?: ReasoningLevel
  /** Tool/session hooks (global config only). */
  hooks?: HooksConfig
  /** In-process plugin observers fired alongside the shell hooks (global config plugins). */
  pluginEmit?: (event: HookEvent, payload?: { tool?: string; input?: unknown; output?: string }) => Promise<void>
  /** Base environment handed to hook processes (defaults to the process env at spawn). */
  env?: NodeJS.ProcessEnv
}

interface Ticket {
  abandoned: boolean
  open: boolean
}

const CANCELLED = 'Cancelled by the user.'

const COMPACT_PROMPT =
  'Summarize the conversation so far for yourself so you can continue the work with no other context. Include: the user goals, decisions made, files touched and their current state, commands run and results, the task in progress and the next step. Be concise but complete.'

export class Agent {
  provider: Provider
  permissions: Permissions
  messages: ChatMessage[]
  totalUsage: Usage = { inputTokens: 0, outputTokens: 0 }
  lastInputTokens = 0
  onEvent: (event: AgentEvent) => void = () => {}
  reasoning: ReasoningLevel
  askPermission: AskPermission = async () => 'no'

  tools: Tool[]
  private definitions: ToolDefinition[]
  // Snapshot for the running turn: tools added/removed mid-turn (e.g. an MCP server connecting) apply from the next turn.
  private turnTools: Tool[]
  private turnDefinitions: ToolDefinition[]
  private readonly readFiles = new Set<string>()
  private readonly webBudget = new WebBudget()
  private readonly maxSteps?: number
  // One window for every model; resolved from contextWindowFor() (catalog + env override).
  private contextWindow: number
  private systemPrompt: string

  constructor(private readonly opts: AgentOptions) {
    this.provider = opts.provider
    this.permissions = opts.permissions
    this.tools = opts.tools
    this.definitions = toolDefinitions(opts.tools)
    this.turnTools = this.tools
    this.turnDefinitions = this.definitions
    this.messages = [...(opts.history ?? [])]
    this.maxSteps =
      typeof opts.maxSteps === 'number' && Number.isFinite(opts.maxSteps) && opts.maxSteps > 0
        ? Math.max(1, Math.floor(opts.maxSteps))
        : undefined
    this.contextWindow = opts.contextWindow ?? 128_000
    this.systemPrompt = opts.systemPrompt
    this.reasoning = opts.reasoning ?? 'auto'
  }

  setSystemPrompt(text: string): void {
    this.systemPrompt = text
  }

  setContextWindow(window: number): void {
    this.contextWindow = window
  }

  setTools(tools: Tool[]): void {
    this.tools = tools
    this.definitions = toolDefinitions(tools)
  }

  private isParallelSafe(call: ToolCall): boolean {
    const tool = this.turnTools.find((t) => t.name === call.name)
    if (!tool?.parallelSafe) return false
    try {
      const parsed = tool.schema.safeParse(JSON.parse(call.arguments || '{}'))
      return parsed.success && tool.parallelSafe(parsed.data)
    } catch {
      return false
    }
  }

  private push(message: ChatMessage): void {
    this.messages.push(message)
    this.opts.onMessage?.(message)
  }

  /** Swaps in another conversation (resume, new session) without writing to the session log. */
  load(messages: ChatMessage[]): void {
    this.messages = messages
    this.readFiles.clear()
    this.webBudget.reset()
    // Seed the estimate so a resumed history that is already over the window compacts
    // before its first real request instead of failing with a provider 400.
    this.lastInputTokens = estimateMessages(messages) + estimateTokens(this.systemPrompt)
  }

  clear(): void {
    this.messages = []
    this.readFiles.clear()
    this.webBudget.reset()
    this.lastInputTokens = 0
    this.opts.onReset?.()
  }

  async compact(signal: AbortSignal): Promise<void> {
    // Even the summary request must fit the window: drop whole oldest turns first when the
    // history itself is too big to send, then summarize what remains.
    const history = trimToFit(this.messages, Math.floor(this.contextWindow * 0.8))
    const completion = await this.provider.chat({
      messages: [{ role: 'system', content: this.systemPrompt }, ...history, { role: 'user', content: COMPACT_PROMPT }],
      // Some gateways reject tool_calls in history when no tools are declared.
      tools: this.definitions,
      signal,
      reasoning: this.reasoning,
    })
    this.clear()
    this.push({ role: 'user', content: `Summary of the previous conversation:\n${completion.text}` })
    this.push({ role: 'assistant', content: 'OK, I will continue from this summary.' })
    this.onEvent({ type: 'compacted' })
  }

  /**
   * Events of one tool execution. A cancelled turn gives up on a tool that does not stop, and whatever that tool
   * reports later must not reach the screen or a newer turn, so this is per execution and not per call id (ids repeat).
   */
  private report(ticket: Ticket, event: AgentEvent): void {
    if (ticket.abandoned) return
    if (event.type === 'toolStart') ticket.open = true
    if (event.type === 'toolEnd') ticket.open = false
    this.onEvent(event)
  }

  async run(text: string, signal: AbortSignal): Promise<void> {
    this.turnTools = this.tools
    this.turnDefinitions = this.definitions
    this.opts.onTurnStart?.()
    this.webBudget.startTurn()
    try {
      if (this.lastInputTokens > this.contextWindow * 0.8 && !hasPendingProgrammaticReplay(this.messages)) await this.compact(signal)
      this.push({ role: 'user', content: text })
      for (let step = 0; this.maxSteps === undefined || step < this.maxSteps; step++) {
        if (step > 0 && this.lastInputTokens > this.contextWindow * 0.8 && !hasPendingProgrammaticReplay(this.messages)) {
          await this.compact(signal)
          // The summary ends with an assistant turn; restate the task so the model has something to answer.
          this.push({ role: 'user', content: `Continue this task using the summary above: ${text}` })
        }
        pruneOldFetches(this.messages)
        let completion = await this.provider.chat({
          messages: [{ role: 'system', content: this.systemPrompt }, ...this.messages],
          tools: this.turnDefinitions,
          programmaticToolNames: this.turnTools.filter((tool) => tool.programmaticSafe).map((tool) => tool.name),
          signal,
          onText: (delta) => this.onEvent({ type: 'text', delta }),
          onThinking: (delta) => this.onEvent({ type: 'thinking', delta }),
          reasoning: this.reasoning,
        })
        if (!completion.toolCalls.length && completion.finishReason !== 'repetition') {
          const recovered = recoverTextToolCalls(completion.text, this.turnDefinitions)
          if (recovered) {
            completion = { ...completion, ...recovered }
            this.onEvent({ type: 'textReplace', text: recovered.text })
          }
        }
        // Some gateways (incl. BotConnector) omit usage; estimate ~4 chars/token so /cost and compaction still work.
        const usage = completion.usage ?? {
          inputTokens: estimateTokens(this.systemPrompt) + estimateTokens(JSON.stringify(this.messages)),
          outputTokens:
            estimateTokens(completion.text) + (completion.toolCalls.length ? estimateTokens(JSON.stringify(completion.toolCalls)) : 0),
        }
        this.totalUsage.inputTokens += usage.inputTokens
        this.totalUsage.outputTokens += usage.outputTokens
        this.totalUsage.cachedInputTokens = (this.totalUsage.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0)
        this.totalUsage.cacheWriteTokens = (this.totalUsage.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        this.lastInputTokens = usage.inputTokens
        this.onEvent({ type: 'usage', ...this.totalUsage })
        this.push(completionAssistantMessage(completion))
        if (completion.finishReason === 'repetition') {
          this.onEvent({ type: 'textReplace', text: completion.text })
          this.onEvent({
            type: 'error',
            message: t('The model got stuck repeating text, so the answer was stopped. Try again or switch models with /model.'),
          })
          return
        }
        if (!completion.toolCalls.length) {
          if (completion.finishReason === 'continue') continue
          this.onEvent({ type: 'done' })
          return
        }
        const calls = completion.toolCalls
        let i = 0
        const roundImages: ImageAttachment[] = []
        while (i < calls.length) {
          if (signal.aborted) {
            this.cancelCalls(calls.slice(i))
            this.onEvent({ type: 'aborted' })
            return
          }
          // Consecutive parallel-safe calls run together; results keep call order.
          let j = i + 1
          if (this.isParallelSafe(calls[i])) while (j < calls.length && this.isParallelSafe(calls[j])) j++
          const batch = calls.slice(i, j)
          const tickets = batch.map((): Ticket => ({ abandoned: false, open: false }))
          const running = Promise.all(batch.map((c, k) => this.runTool(c, signal, tickets[k])))
          // Esc must work even when a tool (a big search, an MCP server, a subagent) does not watch the signal.
          const outcome = await raceAbort(running, signal)
          if (outcome === ABORTED) {
            batch.forEach((c, k) => {
              const ticket = tickets[k]
              ticket.abandoned = true
              if (ticket.open) this.onEvent({ type: 'toolEnd', id: c.id, tool: c.name, output: CANCELLED, isError: true })
            })
            running.catch(() => {})
            this.cancelCalls(calls.slice(i))
            this.onEvent({ type: 'aborted' })
            return
          }
          batch.forEach((c, k) => {
            roundImages.push(...(outcome[k].images ?? []))
            this.push({
              role: 'tool',
              tool_call_id: c.id,
              content: outcome[k].output,
              ...(c.caller ? { responses_caller: c.caller } : {}),
            })
          })
          i = j
        }
        // After every tool call of this response is answered, hand the images to the model
        // as one user message: tool-role array content is not portable across providers.
        if (roundImages.length) this.push(imageUserMessage(roundImages))
        if (signal.aborted) {
          this.onEvent({ type: 'aborted' })
          return
        }
      }
      if (this.maxSteps !== undefined) this.onEvent({ type: 'stepLimit', maxSteps: this.maxSteps })
    } catch (error) {
      if (signal.aborted) {
        this.onEvent({ type: 'aborted' })
        return
      }
      const message = (error as Error).message
      const noTools = (error as { status?: number }).status === 400 && /tool/i.test(message)
      this.onEvent({
        type: 'error',
        message: noTools ? `${message}\n${t('This model may not support tool calling. Try another model with /model.')}` : message,
      })
    }
  }

  /** Every tool call needs an answer in the history, or the next request to the model is rejected. */
  private cancelCalls(calls: ToolCall[]): void {
    for (const pending of calls)
      this.push({
        role: 'tool',
        tool_call_id: pending.id,
        content: CANCELLED,
        ...(pending.caller ? { responses_caller: pending.caller } : {}),
      })
  }

  /**
   * Every tool call must resolve with text: a rejected one would leave the assistant tool_calls
   * without answers, and the next request to the model would be rejected until a restart.
   */
  private async runTool(call: ToolCall, signal: AbortSignal, ticket: Ticket): Promise<ToolOutcome> {
    const emit = (event: AgentEvent) => this.report(ticket, event)
    try {
      return await this.executeTool(call, signal, ticket)
    } catch (error) {
      const message = `Error: ${(error as Error)?.message || String(error)}`
      if (ticket.open) {
        emit({ type: 'toolEnd', id: call.id, tool: call.name, output: message, isError: true })
      } else {
        emit({ type: 'toolStart', id: call.id, tool: call.name, target: '' })
        emit({ type: 'toolEnd', id: call.id, tool: call.name, output: message, isError: true })
      }
      return { output: message }
    }
  }

  private async executeTool(call: ToolCall, signal: AbortSignal, ticket: Ticket): Promise<ToolOutcome> {
    const emit = (event: AgentEvent) => this.report(ticket, event)
    const fail = (output: string, target = '') => {
      emit({ type: 'toolStart', id: call.id, tool: call.name, target })
      emit({ type: 'toolEnd', id: call.id, tool: call.name, output, isError: true })
      return { output }
    }
    const tool = this.turnTools.find((t) => t.name === call.name)
    if (!tool) return fail(`Tool "${call.name}" does not exist. Available tools: ${this.turnTools.map((t) => t.name).join(', ')}`)
    let args: unknown
    try {
      args = JSON.parse(call.arguments || '{}')
    } catch {
      return fail(`Arguments are not valid JSON: ${call.arguments.slice(0, 200)}`)
    }
    const parsed = tool.schema.safeParse(args)
    if (!parsed.success) {
      return fail(`Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
    }
    const input = parsed.data
    const target = tool.target(input)
    const overBudget = tool.name === 'fetch' ? this.webBudget.take() : undefined
    if (overBudget) return fail(overBudget, target)
    // PreToolUse runs before validation and permission prompts: a hook exit 2 blocks the call outright.
    await this.opts.pluginEmit?.('PreToolUse', { tool: tool.name, input })
    const pre = await runHooks(this.opts.hooks, 'PreToolUse', { tool: tool.name, input }, { env: this.opts.env, cwd: this.opts.cwd })
    if (pre.blocked) return fail(pre.blocked, target)
    const ctx: ToolContext = {
      cwd: this.opts.cwd,
      signal,
      readFiles: this.readFiles,
      callId: call.id,
      emit,
      ask: (req) => this.askPermission(req),
      checkpoint: this.opts.checkpoint,
      refundFetch: () => this.webBudget.refund(),
      addUsage: (u) => {
        this.totalUsage.inputTokens += u.inputTokens
        this.totalUsage.outputTokens += u.outputTokens
        this.totalUsage.cachedInputTokens = (this.totalUsage.cachedInputTokens ?? 0) + (u.cachedInputTokens ?? 0)
        this.totalUsage.cacheWriteTokens = (this.totalUsage.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0)
        this.onEvent({ type: 'usage', ...this.totalUsage })
      },
    }
    emit({ type: 'toolStart', id: call.id, tool: tool.name, target })
    // Don't ask the user to approve something that is going to fail anyway.
    const invalid = await tool.validate?.(input, ctx).catch((error: Error) => error.message)
    if (invalid) {
      emit({ type: 'toolEnd', id: call.id, tool: tool.name, output: invalid, isError: true })
      return { output: invalid }
    }
    const request: PermissionRequest = { tool: tool.name, kind: tool.kind, target }
    let decision = this.permissions.check(request)
    if (decision === 'ask') {
      const preview = await tool.preview?.(input, ctx).catch(() => undefined)
      const answer = await this.askPermission({
        ...request,
        preview,
        sessionRules: this.permissions.rulesFor(request),
        ...(this.opts.label ? { agent: this.opts.label } : {}),
      })
      if (answer === 'session') this.permissions.allowForSession(request)
      if (answer === 'all') this.permissions.mode = 'allowAll'
      decision = answer === 'no' ? 'deny' : 'allow'
    }
    if (decision === 'deny') {
      const output =
        this.permissions.mode === 'plan'
          ? 'Denied: plan mode only allows reading and searching. Write the plan for the user without changing anything.'
          : 'The user declined to run this tool. Ask the user what they want, or try another approach.'
      emit({ type: 'toolEnd', id: call.id, tool: tool.name, output, isError: true })
      return { output }
    }
    let result: ToolResult
    try {
      result = await tool.run(input, ctx)
    } catch (error) {
      result = { output: `Error: ${(error as Error).message}`, isError: true }
    }
    if (tool.name === 'fetch' && !result.isError) this.webBudget.record(result.output.length)
    // PostToolUse sees the finished output; its exit code never blocks (the tool already ran).
    await runHooks(
      this.opts.hooks,
      'PostToolUse',
      { tool: tool.name, input, output: result.output },
      { env: this.opts.env, cwd: this.opts.cwd },
    )
    await this.opts.pluginEmit?.('PostToolUse', { tool: tool.name, input, output: result.output })
    emit({ type: 'toolEnd', id: call.id, tool: tool.name, output: result.output, display: result.display, isError: !!result.isError })
    return result
  }
}
