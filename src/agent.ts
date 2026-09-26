import type { PermissionRequest, Permissions } from './permissions'
import type { ChatMessage, Provider, ToolCall, Usage } from './provider'
import { type ToolDefinition, toolDefinitions } from './tools/index'
import type { Tool, ToolContext } from './tools/types'

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'toolStart'; id: string; tool: string; target: string }
  | { type: 'toolEnd'; id: string; tool: string; output: string; display?: string; isError: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'compacted' }
  | { type: 'stepLimit' }
  | { type: 'aborted' }
  | { type: 'error'; message: string }
  | { type: 'done' }

export type PermissionAnswer = 'yes' | 'session' | 'no'
export type AskPermission = (req: PermissionRequest & { preview?: string }) => Promise<PermissionAnswer>

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
}

const COMPACT_PROMPT =
  'Summarize the conversation so far for yourself so you can continue the work with no other context. Include: the user goals, decisions made, files touched and their current state, commands run and results, the task in progress and the next step. Be concise but complete.'

export class Agent {
  provider: Provider
  permissions: Permissions
  messages: ChatMessage[]
  totalUsage: Usage = { inputTokens: 0, outputTokens: 0 }
  lastInputTokens = 0
  onEvent: (event: AgentEvent) => void = () => {}
  askPermission: AskPermission = async () => 'no'

  private readonly tools: Tool[]
  private readonly definitions: ToolDefinition[]
  private readonly readFiles = new Set<string>()
  private readonly maxSteps: number
  // ponytail: one window for every model; read it from /v1/models metadata when providers expose it.
  private readonly contextWindow: number

  constructor(private readonly opts: AgentOptions) {
    this.provider = opts.provider
    this.permissions = opts.permissions
    this.tools = opts.tools
    this.definitions = toolDefinitions(opts.tools)
    this.messages = [...(opts.history ?? [])]
    this.maxSteps = opts.maxSteps ?? 50
    this.contextWindow = opts.contextWindow ?? 128_000
  }

  private push(message: ChatMessage): void {
    this.messages.push(message)
    this.opts.onMessage?.(message)
  }

  clear(): void {
    this.messages = []
    this.readFiles.clear()
    this.lastInputTokens = 0
    this.opts.onReset?.()
  }

  async compact(signal: AbortSignal): Promise<void> {
    const completion = await this.provider.chat({
      messages: [{ role: 'system', content: this.opts.systemPrompt }, ...this.messages, { role: 'user', content: COMPACT_PROMPT }],
      signal,
    })
    this.clear()
    this.push({ role: 'user', content: `Ringkasan percakapan sebelumnya:\n${completion.text}` })
    this.push({ role: 'assistant', content: 'Oke, saya lanjutkan dari ringkasan ini.' })
    this.onEvent({ type: 'compacted' })
  }

  async run(text: string, signal: AbortSignal): Promise<void> {
    try {
      if (this.lastInputTokens > this.contextWindow * 0.8) await this.compact(signal)
      this.push({ role: 'user', content: text })
      for (let step = 0; step < this.maxSteps; step++) {
        if (step > 0 && this.lastInputTokens > this.contextWindow * 0.8) await this.compact(signal)
        const completion = await this.provider.chat({
          messages: [{ role: 'system', content: this.opts.systemPrompt }, ...this.messages],
          tools: this.definitions,
          signal,
          onText: (delta) => this.onEvent({ type: 'text', delta }),
        })
        if (completion.usage) {
          this.totalUsage.inputTokens += completion.usage.inputTokens
          this.totalUsage.outputTokens += completion.usage.outputTokens
          this.lastInputTokens = completion.usage.inputTokens
          this.onEvent({ type: 'usage', ...this.totalUsage })
        }
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
        if (!completion.toolCalls.length) {
          this.onEvent({ type: 'done' })
          return
        }
        for (let i = 0; i < completion.toolCalls.length; i++) {
          const call = completion.toolCalls[i]
          if (signal.aborted) {
            for (const pending of completion.toolCalls.slice(i)) {
              this.push({ role: 'tool', tool_call_id: pending.id, content: 'Dibatalkan oleh user.' })
            }
            this.onEvent({ type: 'aborted' })
            return
          }
          this.push({ role: 'tool', tool_call_id: call.id, content: await this.runTool(call, signal) })
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
    const tool = this.tools.find((t) => t.name === call.name)
    if (!tool) return fail(`Alat "${call.name}" tidak ada. Alat yang tersedia: ${this.tools.map((t) => t.name).join(', ')}`)
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
    const ctx: ToolContext = { cwd: this.opts.cwd, signal, readFiles: this.readFiles }
    this.onEvent({ type: 'toolStart', id: call.id, tool: tool.name, target })
    const request: PermissionRequest = { tool: tool.name, kind: tool.kind, target }
    let decision = this.permissions.check(request)
    if (decision === 'ask') {
      const preview = await tool.preview?.(input, ctx).catch(() => undefined)
      const answer = await this.askPermission({ ...request, preview })
      if (answer === 'session') this.permissions.allowForSession(request)
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
