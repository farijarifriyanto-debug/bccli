import type { PermissionRequest, Permissions } from './permissions'
import type { ChatMessage, Provider, ToolCall, Usage } from './provider'
import type { ReasoningLevel } from './reasoning'
import { type ToolDefinition, toolDefinitions } from './tools/index'
import type { Tool, ToolContext } from './tools/types'
import { recoverTextToolCalls } from './textToolCalls'

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'textReplace'; text: string }
  | { type: 'toolStart'; id: string; tool: string; target: string }
  | { type: 'toolEnd'; id: string; tool: string; output: string; display?: string; isError: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'compacted' }
  | { type: 'stepLimit' }
  | { type: 'aborted' }
  | { type: 'error'; message: string }
  | { type: 'done' }
  | { type: 'subagent'; parentId: string; agent: string; event: AgentEvent }

export type PermissionAnswer = 'yes' | 'session' | 'all' | 'no'
export type PermissionAsk = PermissionRequest & { preview?: string; sessionRules?: string[]; agent?: string }
export type AskPermission = (req: PermissionAsk) => Promise<PermissionAnswer>

export interface AgentOptions {
  provider: Provider
  tools: Tool[]
  permissions: Permissions
  systemPrompt: string
  cwd: string
  history?: ChatMessage[]
  maxSteps?: number
  contextWindow?: number
  onMessage?: (message: ChatMessage) => void
  onReset?: () => void
  /** Marks the start of a user turn (undo boundary). */
  onTurnStart?: () => void
  checkpoint?: (absPath: string) => Promise<void>
  /** Subagent name, shown on its permission prompts. */
  label?: string
  reasoning?: ReasoningLevel
}

const estimateTokens = (text: string) => Math.ceil(text.length / 4)

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
  private readonly maxSteps: number
  // ponytail: one window for every model; read it from /v1/models metadata when providers expose it.
  private readonly contextWindow: number
  private systemPrompt: string

  constructor(private readonly opts: AgentOptions) {
    this.provider = opts.provider
    this.permissions = opts.permissions
    this.tools = opts.tools
    this.definitions = toolDefinitions(opts.tools)
    this.turnTools = this.tools
    this.turnDefinitions = this.definitions
    this.messages = [...(opts.history ?? [])]
    this.maxSteps = opts.maxSteps ?? 50
    this.contextWindow = opts.contextWindow ?? 128_000
    this.systemPrompt = opts.systemPrompt
    this.reasoning = opts.reasoning ?? 'auto'
  }

  setSystemPrompt(text: string): void {
    this.systemPrompt = text
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
    this.lastInputTokens = 0
  }

  clear(): void {
    this.messages = []
    this.readFiles.clear()
    this.lastInputTokens = 0
    this.opts.onReset?.()
  }

  async compact(signal: AbortSignal): Promise<void> {
    const completion = await this.provider.chat({
      messages: [{ role: 'system', content: this.systemPrompt }, ...this.messages, { role: 'user', content: COMPACT_PROMPT }],
      // Some gateways reject tool_calls in history when no tools are declared.
      tools: this.definitions,
      signal,
      reasoning: this.reasoning,
    })
    this.clear()
    this.push({ role: 'user', content: `Ringkasan percakapan sebelumnya:\n${completion.text}` })
    this.push({ role: 'assistant', content: 'Oke, saya lanjutkan dari ringkasan ini.' })
    this.onEvent({ type: 'compacted' })
  }

  async run(text: string, signal: AbortSignal): Promise<void> {
    this.turnTools = this.tools
    this.turnDefinitions = this.definitions
    this.opts.onTurnStart?.()
    try {
      if (this.lastInputTokens > this.contextWindow * 0.8) await this.compact(signal)
      this.push({ role: 'user', content: text })
      for (let step = 0; step < this.maxSteps; step++) {
        if (step > 0 && this.lastInputTokens > this.contextWindow * 0.8) {
          await this.compact(signal)
          // The summary ends with an assistant turn; restate the task so the model has something to answer.
          this.push({ role: 'user', content: `Lanjutkan tugas ini sesuai ringkasan di atas: ${text}` })
        }
        let completion = await this.provider.chat({
          messages: [{ role: 'system', content: this.systemPrompt }, ...this.messages],
          tools: this.turnDefinitions,
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
        this.lastInputTokens = usage.inputTokens
        this.onEvent({ type: 'usage', ...this.totalUsage })
        this.push({
          role: 'assistant',
          content: completion.text || null,
          ...(completion.toolCalls.length
            ? {
                tool_calls: completion.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function' as const,
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        })
        if (completion.finishReason === 'repetition') {
          this.onEvent({ type: 'textReplace', text: completion.text })
          this.onEvent({
            type: 'error',
            message: 'Model terjebak mengulang teks, jawaban dihentikan. Coba ulangi atau ganti model dengan /model.',
          })
          return
        }
        if (!completion.toolCalls.length) {
          this.onEvent({ type: 'done' })
          return
        }
        const calls = completion.toolCalls
        let i = 0
        while (i < calls.length) {
          if (signal.aborted) {
            for (const pending of calls.slice(i)) this.push({ role: 'tool', tool_call_id: pending.id, content: 'Dibatalkan oleh user.' })
            this.onEvent({ type: 'aborted' })
            return
          }
          // Consecutive parallel-safe calls run together; results keep call order.
          let j = i + 1
          if (this.isParallelSafe(calls[i])) while (j < calls.length && this.isParallelSafe(calls[j])) j++
          const batch = calls.slice(i, j)
          const results = await Promise.all(batch.map((c) => this.runTool(c, signal)))
          batch.forEach((c, k) => {
            this.push({ role: 'tool', tool_call_id: c.id, content: results[k] })
          })
          i = j
        }
        if (signal.aborted) {
          this.onEvent({ type: 'aborted' })
          return
        }
      }
      this.onEvent({ type: 'stepLimit' })
    } catch (error) {
      if (signal.aborted) {
        this.onEvent({ type: 'aborted' })
        return
      }
      const message = (error as Error).message
      const noTools = (error as { status?: number }).status === 400 && /tool/i.test(message)
      this.onEvent({
        type: 'error',
        message: noTools ? `${message}\nModel ini sepertinya tidak mendukung tool calling. Coba model lain dengan /model.` : message,
      })
    }
  }

  private async runTool(call: ToolCall, signal: AbortSignal): Promise<string> {
    const fail = (output: string, target = '') => {
      this.onEvent({ type: 'toolStart', id: call.id, tool: call.name, target })
      this.onEvent({ type: 'toolEnd', id: call.id, tool: call.name, output, isError: true })
      return output
    }
    const tool = this.turnTools.find((t) => t.name === call.name)
    if (!tool) return fail(`Alat "${call.name}" tidak ada. Alat yang tersedia: ${this.turnTools.map((t) => t.name).join(', ')}`)
    let args: unknown
    try {
      args = JSON.parse(call.arguments || '{}')
    } catch {
      return fail(`Argumen bukan JSON valid: ${call.arguments.slice(0, 200)}`)
    }
    const parsed = tool.schema.safeParse(args)
    if (!parsed.success) {
      return fail(`Argumen tidak valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`)
    }
    const input = parsed.data
    const target = tool.target(input)
    const ctx: ToolContext = {
      cwd: this.opts.cwd,
      signal,
      readFiles: this.readFiles,
      callId: call.id,
      emit: (event) => this.onEvent(event),
      ask: (req) => this.askPermission(req),
      checkpoint: this.opts.checkpoint,
      addUsage: (u) => {
        this.totalUsage.inputTokens += u.inputTokens
        this.totalUsage.outputTokens += u.outputTokens
        this.onEvent({ type: 'usage', ...this.totalUsage })
      },
    }
    this.onEvent({ type: 'toolStart', id: call.id, tool: tool.name, target })
    // Don't ask the user to approve something that is going to fail anyway.
    const invalid = await tool.validate?.(input, ctx).catch((error: Error) => error.message)
    if (invalid) {
      this.onEvent({ type: 'toolEnd', id: call.id, tool: tool.name, output: invalid, isError: true })
      return invalid
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
          ? 'Ditolak: mode plan hanya boleh membaca dan mencari. Susun rencana untuk user tanpa mengubah apa pun.'
          : 'User menolak menjalankan alat ini. Tanyakan ke user apa yang diinginkan, atau coba cara lain.'
      this.onEvent({ type: 'toolEnd', id: call.id, tool: tool.name, output, isError: true })
      return output
    }
    let result: { output: string; isError?: boolean; display?: string }
    try {
      result = await tool.run(input, ctx)
    } catch (error) {
      result = { output: `Error: ${(error as Error).message}`, isError: true }
    }
    this.onEvent({ type: 'toolEnd', id: call.id, tool: tool.name, output: result.output, display: result.display, isError: !!result.isError })
    return result.output
  }
}
