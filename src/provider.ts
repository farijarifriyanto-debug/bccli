import OpenAI from 'openai'
import { ResponsesWS } from 'openai/resources/responses/ws'
import { toResponseInputItems } from 'openai/lib/responses/ResponseInputItems'
import type { ResponseOutputItem, ResponsesClientEvent, ResponsesServerEvent } from 'openai/resources/responses/responses'
import { splitThinking, ThinkSplitter } from './thinking'
import { reasoningPayload, type ReasoningLevel } from './reasoning'
import type { ToolDefinition } from './tools/index'
import { t } from './i18n'

// BotConnector policy (not an OpenAI-mandated value): compact before the 272k Luna request cap.
const LUNA_AUTO_COMPACT_THRESHOLD = 240_000

export interface ResponsesProgramCaller {
  type: 'program'
  caller_id: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
  caller?: ResponsesProgramCaller
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string }; caller?: ResponsesProgramCaller }[]
      /** Exact OpenAI Responses output items for stateless Luna replay/reconnect. Hidden from normal UI/export. */
      responses_output_items?: ResponseOutputItem[]
    }
  | {
      role: 'tool'
      tool_call_id: string
      content: string
      /** Program caller linkage must be round-tripped for PTC continuation. */
      responses_caller?: ResponsesProgramCaller
    }

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface Completion {
  text: string
  toolCalls: ToolCall[]
  /** Exact OpenAI Responses output items, preserved for store:false replay. */
  responsesOutputItems?: ResponseOutputItem[]
  /** The model's reasoning, when it sends any (reasoning_content or <think> blocks); not part of the history. */
  thinking?: string
  usage?: Usage
  finishReason?: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  onText?: (delta: string) => void
  onThinking?: (delta: string) => void
  reasoning?: ReasoningLevel
}

export interface Provider {
  chat(req: ChatRequest): Promise<Completion>
  listModels(): Promise<string[]>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

interface ProviderOptions {
  baseURL: string
  apiKey?: string
  model: string
  providerId?: string
  fetch?: typeof fetch
  retryDelayMs?: number
  responsesWebSocketFactory?: (client: OpenAI) => ResponsesWS
  /** Experimental Luna-only PTC canary. Kept opt-in until replay/cost canaries pass. */
  enableProgrammaticToolCalling?: boolean
}

interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
}
interface RawToolCall {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
}

interface ResponsesOutputItem {
  type?: string
  id?: string
  call_id?: string
  name?: string
  arguments?: string
  caller?: { type?: string; caller_id?: string }
  content?: { type?: string; text?: string; refusal?: string }[]
  [key: string]: unknown
}

interface ResponsesPayload {
  id?: string
  output?: ResponsesOutputItem[]
  usage?: ResponsesUsage
  status?: string
  error?: { message?: string }
  incomplete_details?: { reason?: string }
}

interface ResponsesStreamEvent {
  type?: string
  delta?: string
  output_index?: number
  message?: string
  error?: { message?: string }
  item?: ResponsesOutputItem
  response?: ResponsesPayload
}

const retryable = (status: number) => status === 429 || status >= 500

/**
 * Small models sometimes get stuck emitting the same few characters forever.
 * Returns where the loop starts when the tail is one short unit (1-12 chars, not just
 * whitespace) repeated at least 20 times over 300+ chars; otherwise -1. Normal markdown
 * rules like 80 "=" stay under the length threshold.
 */
export function detectRepetition(text: string): number {
  const tail = text.slice(-600)
  for (let len = 1; len <= 12; len++) {
    const unit = tail.slice(-len)
    if (unit.length < len || !unit.trim()) continue
    let i = tail.length
    let count = 0
    while (i >= len && tail.slice(i - len, i) === unit) {
      count++
      i -= len
    }
    if (count >= 20 && count * len >= 300) return text.length - count * len
  }
  return -1
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body)
    return parsed?.error?.message ?? parsed?.message ?? body.slice(0, 300)
  } catch {
    return body.slice(0, 300)
  }
}

const toUsage = (u?: RawUsage): Usage | undefined =>
  u ? { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 } : undefined

async function readStream(res: Response, onText?: (delta: string) => void, onThinking?: (delta: string) => void): Promise<Completion> {
  let text = ''
  let thinking = ''
  const splitter = new ThinkSplitter()
  const emit = (part: { text: string; thinking: string }) => {
    if (part.thinking) {
      thinking += part.thinking
      onThinking?.(part.thinking)
    }
    if (part.text) {
      text += part.text
      onText?.(part.text)
      if (loopAt < 0) loopAt = detectRepetition(text)
    }
  }
  let usage: Usage | undefined
  let finishReason: string | undefined
  const calls: ToolCall[] = []
  const byIndex = new Map<number, ToolCall>()
  let current: ToolCall | undefined
  const decoder = new TextDecoder()
  let buffer = ''
  let loopAt = -1
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let event: {
      choices?: {
        delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: RawToolCall[] }
        finish_reason?: string
      }[]
      usage?: RawUsage
      error?: { message?: string }
    }
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    if (event.error) throw new ProviderError(t('Error from the provider: {message}', { message: event.error.message ?? JSON.stringify(event.error) }))
    if (event.usage) usage = toUsage(event.usage)
    const choice = event.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta ?? {}
    const reasoning = delta.reasoning_content || delta.reasoning
    if (reasoning) emit({ text: '', thinking: reasoning })
    if (delta.content) emit(splitter.push(delta.content))
    for (const tc of delta.tool_calls ?? []) {
      // Fragments are grouped by index; providers that omit index start a new call with a new id.
      let target = tc.index !== undefined ? byIndex.get(tc.index) : current
      if (!target || (tc.index === undefined && tc.id && target.id && target.id !== tc.id)) {
        target = { id: '', name: '', arguments: '' }
        calls.push(target)
        if (tc.index !== undefined) byIndex.set(tc.index, target)
      }
      current = target
      if (tc.id) target.id = tc.id
      if (tc.function?.name && !target.name) target.name = tc.function.name
      if (tc.function?.arguments) target.arguments += tc.function.arguments
    }
  }
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0 && loopAt < 0) {
      handle(buffer.slice(0, newline).trim())
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
    // Stop reading (and cancel the request) instead of streaming the loop until the provider's limit.
    if (loopAt >= 0) return { text: text.slice(0, loopAt), toolCalls: [], thinking: thinking || undefined, usage, finishReason: 'repetition' }
  }
  handle(buffer.trim())
  emit(splitter.flush())
  const toolCalls = calls.map((call, index) => ({ ...call, id: call.id || `call_${index}` }))
  return { text, toolCalls, thinking: thinking || undefined, usage, finishReason }
}

async function readJson(res: Response): Promise<Completion> {
  const body = (await res.json()) as {
    choices?: {
      message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: RawToolCall[] }
      finish_reason?: string
    }[]
    usage?: RawUsage
  }
  const choice = body.choices?.[0]
  const toolCalls = (choice?.message?.tool_calls ?? []).map((tc, i) => ({
    id: tc.id || `call_${i}`,
    name: tc.function?.name ?? '',
    arguments: tc.function?.arguments ?? '',
  }))
  const split = splitThinking(choice?.message?.content ?? '')
  const thinking = (choice?.message?.reasoning_content || choice?.message?.reasoning || '') + split.thinking
  return { text: split.text, toolCalls, thinking: thinking || undefined, usage: toUsage(body.usage), finishReason: choice?.finish_reason }
}

export function responseInputFromMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      input.push({ role: message.role, content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      if (message.responses_output_items?.length) {
        input.push(...(toResponseInputItems(message.responses_output_items) as unknown as Record<string, unknown>[]))
        continue
      }
      if (message.content) input.push({ role: 'assistant', content: message.content })
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || '{}',
          ...(call.caller ? { caller: call.caller } : {}),
        })
      }
      continue
    }
    input.push({
      type: 'function_call_output',
      call_id: message.tool_call_id,
      output: message.content,
      ...(message.responses_caller ? { caller: message.responses_caller } : {}),
    })
  }
  return input
}

const LUNA_TOOL_SEARCH_MIN_MCP_TOOLS = 20
const LUNA_TOOL_SEARCH_MIN_MCP_SCHEMA_CHARS = 32_000

const LUNA_PTC_SAFE_FUNCTIONS = new Set(['read', 'grep', 'glob'])

export interface LunaToolPlan {
  tools: Record<string, unknown>[]
  useToolSearch: boolean
  useProgrammaticToolCalling: boolean
  deferredToolCount: number
  deferredSchemaChars: number
}

export function lunaToolPlan(tools?: ToolDefinition[], enableProgrammaticToolCalling = false): LunaToolPlan {
  const native: Record<string, unknown>[] = (tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }))
  const mcpIndexes = native
    .map((tool, index) => (String(tool.name).startsWith('mcp__') ? index : -1))
    .filter((index) => index >= 0)
  const deferredSchemaChars = mcpIndexes.reduce((sum, index) => sum + JSON.stringify(native[index]).length, 0)
  const useToolSearch =
    mcpIndexes.length >= LUNA_TOOL_SEARCH_MIN_MCP_TOOLS || deferredSchemaChars >= LUNA_TOOL_SEARCH_MIN_MCP_SCHEMA_CHARS

  let programmaticToolCount = 0
  if (enableProgrammaticToolCalling) {
    for (let index = 0; index < native.length; index++) {
      if (LUNA_PTC_SAFE_FUNCTIONS.has(String(native[index].name))) {
        native[index] = { ...native[index], allowed_callers: ['direct', 'programmatic'] }
        programmaticToolCount++
      }
    }
    if (programmaticToolCount > 0) native.push({ type: 'programmatic_tool_calling' })
  }
  const useProgrammaticToolCalling = programmaticToolCount > 0

  if (!useToolSearch) {
    return {
      tools: native,
      useToolSearch: false,
      useProgrammaticToolCalling,
      deferredToolCount: 0,
      deferredSchemaChars,
    }
  }

  for (const index of mcpIndexes) native[index] = { ...native[index], defer_loading: true }
  native.push({
    type: 'tool_search',
    execution: 'server',
  })
  return {
    tools: native,
    useToolSearch: true,
    useProgrammaticToolCalling,
    deferredToolCount: mcpIndexes.length,
    deferredSchemaChars,
  }
}

function responseTools(tools: ToolDefinition[] | undefined, enableProgrammaticToolCalling = false): Record<string, unknown>[] {
  return lunaToolPlan(tools, enableProgrammaticToolCalling).tools
}

function responseReasoning(level: ReasoningLevel): Record<string, unknown> {
  if (level === 'auto') return {}
  return { reasoning: { effort: level === 'off' ? 'none' : level } }
}

function toResponsesUsage(usage?: { input_tokens?: number; output_tokens?: number }): Usage | undefined {
  return usage ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 } : undefined
}

function programCaller(item?: ResponsesOutputItem): ResponsesProgramCaller | undefined {
  const caller = item?.caller
  return caller?.type === 'program' && typeof caller.caller_id === 'string'
    ? { type: 'program', caller_id: caller.caller_id }
    : undefined
}

function responsesFinishReason(
  items: ResponseOutputItem[] | undefined,
  toolCallCount: number,
  incompleteReason?: string,
): string {
  if (incompleteReason) return incompleteReason
  if (toolCallCount) return 'tool_calls'
  const hasMessage = items?.some((item) => item.type === 'message') ?? false
  const hasProgramState = items?.some((item) => item.type === 'program' || item.type === 'program_output') ?? false
  return !hasMessage && hasProgramState ? 'continue' : 'stop'
}

export function hasPendingProgrammaticReplay(messages: ChatMessage[]): boolean {
  let pending = false
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const item of message.responses_output_items ?? []) {
      if (item.type === 'program') pending = true
      else if (item.type === 'message' && pending) pending = false
    }
  }
  return pending
}

async function readResponsesStream(
  res: Response,
  onText?: (delta: string) => void,
): Promise<Completion> {
  let text = ''
  let usage: Usage | undefined
  let finishReason: string | undefined
  let loopAt = -1
  const calls = new Map<number, ToolCall>()
  const outputItems = new Map<number, ResponsesOutputItem>()
  let responsesOutputItems: ResponseOutputItem[] | undefined
  const decoder = new TextDecoder()
  let buffer = ''

  const emitText = (delta: string) => {
    if (!delta) return
    text += delta
    onText?.(delta)
    if (loopAt < 0) loopAt = detectRepetition(text)
  }

  const handle = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(data) as ResponsesStreamEvent
    } catch {
      return
    }
    if (event.type === 'error') {
      throw new ProviderError(t('Error from the provider: {message}', { message: event.message ?? event.error?.message ?? JSON.stringify(event) }))
    }
    if (event.type === 'response.failed') {
      throw new ProviderError(t('Error from the provider: {message}', { message: event.response?.error?.message ?? 'Response failed' }))
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      emitText(String(event.delta ?? ''))
      return
    }
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      calls.set(Number(event.output_index ?? calls.size), {
        id: String(event.item.call_id || event.item.id || `call_${calls.size}`),
        name: String(event.item.name || ''),
        arguments: String(event.item.arguments || ''),
        ...(programCaller(event.item) ? { caller: programCaller(event.item) } : {}),
      })
      return
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const index = Number(event.output_index ?? 0)
      const call = calls.get(index)
      if (call) call.arguments += String(event.delta || '')
      return
    }
    if (event.type === 'response.output_item.done' && event.item) {
      const index = Number(event.output_index ?? outputItems.size)
      outputItems.set(index, event.item)
      if (event.item.type === 'function_call') {
        const current = calls.get(index)
        calls.set(index, {
          id: String(event.item.call_id || current?.id || event.item.id || `call_${index}`),
          name: String(event.item.name || current?.name || ''),
          arguments: String(event.item.arguments ?? current?.arguments ?? ''),
          ...((programCaller(event.item) ?? current?.caller) ? { caller: programCaller(event.item) ?? current?.caller } : {}),
        })
      }
      return
    }
    if (event.type === 'response.completed') {
      usage = toResponsesUsage(event.response?.usage)
      responsesOutputItems = (event.response?.output as ResponseOutputItem[] | undefined) ??
        [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item as ResponseOutputItem)
      finishReason = responsesFinishReason(responsesOutputItems, calls.size)
      return
    }
    if (event.type === 'response.incomplete') {
      usage = toResponsesUsage(event.response?.usage)
      responsesOutputItems = (event.response?.output as ResponseOutputItem[] | undefined) ??
        [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item as ResponseOutputItem)
      finishReason = responsesFinishReason(
        responsesOutputItems,
        calls.size,
        String(event.response?.incomplete_details?.reason || 'incomplete'),
      )
    }
  }

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0 && loopAt < 0) {
      handle(buffer.slice(0, newline).trim())
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
    if (loopAt >= 0) {
      return { text: text.slice(0, loopAt), toolCalls: [], usage, finishReason: 'repetition' }
    }
  }
  handle(buffer.trim())
  return {
    text,
    toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
    usage,
    finishReason,
    responsesOutputItems,
  }
}

async function readResponsesJson(res: Response): Promise<Completion> {
  const body = (await res.json()) as ResponsesPayload
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const item of body.output ?? []) {
    if (item?.type === 'message') {
      for (const part of item.content ?? []) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text
        else if (part?.type === 'refusal' && typeof part.refusal === 'string') text += part.refusal
      }
    } else if (item?.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id || item.id || `call_${toolCalls.length}`),
        name: String(item.name || ''),
        arguments: String(item.arguments || '{}'),
        ...(programCaller(item) ? { caller: programCaller(item) } : {}),
      })
    }
  }
  return {
    text,
    toolCalls,
    usage: toResponsesUsage(body.usage),
    responsesOutputItems: body.output as ResponseOutputItem[] | undefined,
    finishReason: responsesFinishReason(
      body.output as ResponseOutputItem[] | undefined,
      toolCalls.length,
      body.status === 'incomplete' ? String(body.incomplete_details?.reason || 'incomplete') : undefined,
    ),
  }
}

type ResponsesWsIterator = ReturnType<ResponsesWS['stream']>

interface LunaWsContinuation {
  responseId: string
  requestMessages: ChatMessage[]
  completion: Completion
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return structuredClone(messages)
}

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function completionAssistantMessage(completion: Completion): ChatMessage {
  return {
    role: 'assistant',
    content: completion.text || null,
    ...(completion.toolCalls.length
      ? {
          tool_calls: completion.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
            ...(call.caller ? { caller: call.caller } : {}),
          })),
        }
      : {}),
    ...(completion.responsesOutputItems?.length ? { responses_output_items: completion.responsesOutputItems } : {}),
  }
}

export function responseContinuationInput(
  messages: ChatMessage[],
  continuation?: LunaWsContinuation,
): { input: Record<string, unknown>[]; previousResponseId?: string; incremental: boolean } {
  if (!continuation || messages.length <= continuation.requestMessages.length) {
    return { input: responseInputFromMessages(messages), incremental: false }
  }
  for (let i = 0; i < continuation.requestMessages.length; i++) {
    if (!sameMessage(messages[i], continuation.requestMessages[i])) {
      return { input: responseInputFromMessages(messages), incremental: false }
    }
  }
  const expectedAssistant = completionAssistantMessage(continuation.completion)
  const assistant = messages[continuation.requestMessages.length]
  if (!assistant || !sameMessage(assistant, expectedAssistant)) {
    return { input: responseInputFromMessages(messages), incremental: false }
  }
  const delta = messages.slice(continuation.requestMessages.length + 1)
  if (!delta.length) {
    if (continuation.completion.finishReason === 'continue') {
      return { input: [], previousResponseId: continuation.responseId, incremental: true }
    }
    return { input: responseInputFromMessages(messages), incremental: false }
  }
  return {
    input: responseInputFromMessages(delta),
    previousResponseId: continuation.responseId,
    incremental: true,
  }
}

interface LunaWsTurnResult {
  completion: Completion
  responseId: string
}

async function readResponsesWebSocketTurn(
  events: ResponsesWsIterator,
  ws: ResponsesWS,
  onText?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<LunaWsTurnResult> {
  let responseId = ''
  let text = ''
  let usage: Usage | undefined
  let finishReason: string | undefined
  let loopAt = -1
  const calls = new Map<number, ToolCall>()
  const outputItems = new Map<number, ResponsesOutputItem>()

  const emitText = (delta: string) => {
    if (!delta) return
    text += delta
    onText?.(delta)
    if (loopAt < 0) loopAt = detectRepetition(text)
  }

  const abort = () => {
    try {
      ws.close({ code: 1000, reason: 'BCCLI request cancelled' })
    } catch {}
  }
  signal?.addEventListener('abort', abort, { once: true })

  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error('Request aborted')
      const next = await events.next()
      if (next.done) throw new ProviderError(t('Connection closed before the response finished.'))

      const envelope = next.value
      if (envelope.type === 'error') {
        throw new ProviderError(envelope.error.message || t('WebSocket connection failed.'))
      }
      if (envelope.type === 'close') {
        throw new ProviderError(
          t('WebSocket connection closed: {reason}', { reason: envelope.reason || String(envelope.code) }),
        )
      }
      if (envelope.type !== 'message') continue

      const event = envelope.message as ResponsesServerEvent & ResponsesStreamEvent & { stream_id?: string; status?: number }
      if (event.type === 'error') {
        const code = 'code' in (event.error ?? {}) ? String((event.error as { code?: string }).code || '') : undefined
        throw new ProviderError(
          t('Error from the provider: {message}', { message: event.error?.message ?? event.message ?? JSON.stringify(event) }),
          event.status,
          code,
        )
      }
      if (event.type === 'response.created') {
        responseId = String(event.response?.id || responseId)
        continue
      }
      if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        emitText(String(event.delta ?? ''))
        if (loopAt >= 0) {
          abort()
          return {
            responseId,
            completion: { text: text.slice(0, loopAt), toolCalls: [], usage, finishReason: 'repetition' },
          }
        }
        continue
      }
      if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
        const index = Number(event.output_index ?? calls.size)
        calls.set(index, {
          id: String(event.item.call_id || event.item.id || `call_${index}`),
          name: String(event.item.name || ''),
          arguments: String(event.item.arguments || ''),
          ...(programCaller(event.item) ? { caller: programCaller(event.item) } : {}),
        })
        continue
      }
      if (event.type === 'response.function_call_arguments.delta') {
        const index = Number(event.output_index ?? 0)
        const call = calls.get(index)
        if (call) call.arguments += String(event.delta || '')
        continue
      }
      if (event.type === 'response.output_item.done' && event.item) {
        const index = Number(event.output_index ?? outputItems.size)
        outputItems.set(index, event.item)
        if (event.item.type === 'function_call') {
          const current = calls.get(index)
          calls.set(index, {
            id: String(event.item.call_id || current?.id || event.item.id || `call_${index}`),
            name: String(event.item.name || current?.name || ''),
            arguments: String(event.item.arguments ?? current?.arguments ?? ''),
            ...((programCaller(event.item) ?? current?.caller) ? { caller: programCaller(event.item) ?? current?.caller } : {}),
          })
        }
        continue
      }
      if (event.type === 'response.failed') {
        throw new ProviderError(
          t('Error from the provider: {message}', { message: event.response?.error?.message ?? 'Response failed' }),
        )
      }
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        responseId = String(event.response?.id || responseId)
        usage = toResponsesUsage(event.response?.usage)
        const responsesOutputItems =
          (event.response?.output as ResponseOutputItem[] | undefined) ??
          [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item as ResponseOutputItem)
        finishReason = responsesFinishReason(
          responsesOutputItems,
          calls.size,
          event.type === 'response.incomplete'
            ? String(event.response?.incomplete_details?.reason || 'incomplete')
            : undefined,
        )
        return {
          responseId,
          completion: {
            text,
            toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
            usage,
            finishReason,
            responsesOutputItems,
          },
        }
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}

export function createProvider(options: ProviderOptions): Provider {
  const {
    baseURL,
    apiKey,
    model,
    providerId,
    fetch: fetchOverride,
    retryDelayMs = 1000,
    responsesWebSocketFactory,
    enableProgrammaticToolCalling = false,
  } = options
  const doFetch = fetchOverride ?? fetch
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  // ACCESS-CONTROL CONTRACT: BotConnector Cloud uses these headers to distinguish BCCLI
  // from generic API clients. GPT-6 Luna Launch Access is intentionally limited to the
  // official BotConnector Web App and BCCLI. Do not remove/rename these headers during
  // provider refactors without coordinating the server-side Luna access guard and tests.
  const isBotConnectorCloud = /^https:\/\/api\.botconnector\.id\/v1\/?$/.test(baseURL) && apiKey?.startsWith('bc_live_')
  if (isBotConnectorCloud) {
    headers['x-botconnector-client'] = 'bccli'
    headers['x-botconnector-client-version'] = '0.4.0'
  }
  const useNativeResponses = isBotConnectorCloud && providerId === 'bc-cloud' && model === 'gpt-6-luna'
  const useResponsesWebSocket =
    useNativeResponses && Boolean(apiKey) && (fetchOverride === undefined || responsesWebSocketFactory !== undefined)

  let lunaWs: ResponsesWS | undefined
  let lunaWsEvents: ResponsesWsIterator | undefined
  let lunaContinuation: LunaWsContinuation | undefined
  let lunaWsIdleTimer: NodeJS.Timeout | undefined

  const resetLunaWebSocket = () => {
    if (lunaWsIdleTimer) clearTimeout(lunaWsIdleTimer)
    lunaWsIdleTimer = undefined
    const current = lunaWs
    lunaWs = undefined
    lunaWsEvents = undefined
    lunaContinuation = undefined
    if (current) {
      try {
        current.close({ code: 1000, reason: 'BCCLI reset' })
      } catch {}
    }
  }

  const ensureLunaWebSocket = (): { ws: ResponsesWS; events: ResponsesWsIterator } => {
    if (lunaWsIdleTimer) clearTimeout(lunaWsIdleTimer)
    lunaWsIdleTimer = undefined
    if (!lunaWs || !lunaWsEvents) {
      const client = new OpenAI({
        apiKey: apiKey!,
        baseURL: baseURL.replace(/\/+$/, ''),
        defaultHeaders: {
          'x-botconnector-client': 'bccli',
          'x-botconnector-client-version': '0.4.0',
        },
      })
      lunaWs = responsesWebSocketFactory ? responsesWebSocketFactory(client) : new ResponsesWS(client, { reconnect: null })
      lunaWsEvents = lunaWs.stream({ maxBufferedEvents: 4096 })
    }
    return { ws: lunaWs, events: lunaWsEvents }
  }

  const scheduleLunaWebSocketIdleReset = () => {
    if (lunaWsIdleTimer) clearTimeout(lunaWsIdleTimer)
    lunaWsIdleTimer = setTimeout(() => resetLunaWebSocket(), 10 * 60_000)
    lunaWsIdleTimer.unref?.()
  }

  async function chatLunaWebSocket(
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    reasoning: ReasoningLevel,
    signal: AbortSignal | undefined,
    onText: ((delta: string) => void) | undefined,
  ): Promise<Completion> {
    const nativeTools = responseTools(tools, enableProgrammaticToolCalling)
    const initialPlan = responseContinuationInput(messages, lunaContinuation)

    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw signal.reason ?? new Error('Request aborted')
      const plan =
        attempt === 0
          ? initialPlan
          : { input: responseInputFromMessages(messages), incremental: false as const, previousResponseId: undefined }
      const { ws, events } = ensureLunaWebSocket()
      const createEvent = {
        type: 'response.create',
        stream_id: 'main',
        model,
        store: false,
        input: plan.input,
        ...(plan.previousResponseId ? { previous_response_id: plan.previousResponseId } : {}),
        ...(nativeTools.length ? { tools: nativeTools } : {}),
        context_management: [{ type: 'compaction', compact_threshold: LUNA_AUTO_COMPACT_THRESHOLD }],
        ...responseReasoning(reasoning),
      } as unknown as ResponsesClientEvent

      let emittedText = false
      const trackText = (delta: string) => {
        if (delta) emittedText = true
        onText?.(delta)
      }

      try {
        ws.send(createEvent)
        const result = await readResponsesWebSocketTurn(events, ws, trackText, signal)
        if (result.completion.finishReason === 'repetition') {
          resetLunaWebSocket()
          return result.completion
        }
        if (!result.responseId) {
          resetLunaWebSocket()
          return result.completion
        }
        lunaContinuation = {
          responseId: result.responseId,
          requestMessages: cloneMessages(messages),
          completion: structuredClone(result.completion),
        }
        scheduleLunaWebSocketIdleReset()
        return result.completion
      } catch (error) {
        const err = error instanceof ProviderError ? error : new ProviderError((error as Error).message)
        const lostPrevious = err.code === 'previous_response_not_found'
        const connectionLost =
          /websocket|connection closed|socket|network/i.test(err.message) ||
          err.code === 'websocket_connection_limit_reached'
        resetLunaWebSocket()
        if (
          attempt === 0 &&
          !emittedText &&
          !signal?.aborted &&
          (plan.incremental || lostPrevious || connectionLost)
        ) {
          continue
        }
        if (!emittedText && !signal?.aborted && connectionLost) {
          throw new ProviderError(err.message, err.status, 'bc_ws_http_fallback')
        }
        throw err
      }
    }

    throw new ProviderError(t('Request failed'))
  }

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let lastError: ProviderError | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1), signal)
      let res: Response
      try {
        res = await doFetch(`${baseURL}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal })
      } catch (error) {
        if (signal?.aborted) throw error
        lastError = new ProviderError(t('Cannot connect to {url}: {error}', { url: baseURL, error: (error as Error).message }))
        continue
      }
      if (res.ok) return res
      const text = await res.text().catch(() => '')
      lastError = new ProviderError(t('{status} from {url}: {message}', { status: res.status, url: baseURL, message: errorMessage(text) }), res.status)
      if (!retryable(res.status)) throw lastError
    }
    throw lastError ?? new ProviderError(t('Request failed'))
  }

  return {
    async chat({ messages, tools, signal, onText, onThinking, reasoning = 'auto' }) {
      let reasoningOverride: Record<string, unknown>
      try {
        reasoningOverride = reasoningPayload(providerId, reasoning)
      } catch (error) {
        throw new ProviderError((error as Error).message)
      }

      if (useResponsesWebSocket) {
        try {
          return await chatLunaWebSocket(messages, tools, reasoning, signal, onText)
        } catch (error) {
          const err = error instanceof ProviderError ? error : new ProviderError((error as Error).message)
          if (err.code !== 'bc_ws_http_fallback') throw err
        }
      }

      if (useNativeResponses) {
        const nativeTools = responseTools(tools, enableProgrammaticToolCalling)
        const res = await post(
          '/responses',
          {
            model,
            input: responseInputFromMessages(messages),
            stream: true,
            store: false,
            ...(nativeTools.length ? { tools: nativeTools } : {}),
            context_management: [{ type: 'compaction', compact_threshold: LUNA_AUTO_COMPACT_THRESHOLD }],
            ...responseReasoning(reasoning),
          },
          signal,
        )
        if ((res.headers.get('content-type') ?? '').includes('application/json')) return readResponsesJson(res)
        if (!res.body) throw new ProviderError(t('Empty response from the provider'))
        // OpenAI raw reasoning events are intentionally not surfaced. BCCLI only streams final text and tool calls.
        return readResponsesStream(res, onText)
      }

      const res = await post(
        '/chat/completions',
        { model, messages, stream: true, stream_options: { include_usage: true }, ...(tools?.length ? { tools } : {}), ...reasoningOverride },
        signal,
      )
      if ((res.headers.get('content-type') ?? '').includes('application/json')) return readJson(res)
      if (!res.body) throw new ProviderError(t('Empty response from the provider'))
      return readStream(res, onText, onThinking)
    },
    async listModels() {
      const res = await doFetch(`${baseURL}/models`, { headers })
      if (!res.ok) throw new ProviderError(t('{status} while fetching the model list', { status: res.status }), res.status)
      const body = (await res.json()) as { data?: { id: string }[] }
      return (body.data ?? []).map((m) => m.id).sort()
    },
  }
}
