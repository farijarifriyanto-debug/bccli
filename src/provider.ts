import { splitThinking, ThinkSplitter } from './thinking'
import { reasoningPayload, type ReasoningLevel } from './reasoning'
import type { ToolDefinition } from './tools/index'
import { t } from './i18n'

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface Usage {
  inputTokens: number
  outputTokens: number
}

export interface Completion {
  text: string
  toolCalls: ToolCall[]
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
  content?: { type?: string; text?: string; refusal?: string }[]
}

interface ResponsesPayload {
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

function responseInputFromMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'user') {
      input.push({ role: message.role, content: message.content })
      continue
    }
    if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: message.content })
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments || '{}',
        })
      }
      continue
    }
    input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content })
  }
  return input
}

function responseTools(tools?: ToolDefinition[]): Record<string, unknown>[] {
  return (tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }))
}

function responseReasoning(level: ReasoningLevel): Record<string, unknown> {
  if (level === 'auto') return {}
  return { reasoning: { effort: level === 'off' ? 'none' : level } }
}

function toResponsesUsage(usage?: { input_tokens?: number; output_tokens?: number }): Usage | undefined {
  return usage ? { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 } : undefined
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
      })
      return
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const index = Number(event.output_index ?? 0)
      const call = calls.get(index)
      if (call) call.arguments += String(event.delta || '')
      return
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      const index = Number(event.output_index ?? 0)
      const current = calls.get(index)
      calls.set(index, {
        id: String(event.item.call_id || current?.id || event.item.id || `call_${index}`),
        name: String(event.item.name || current?.name || ''),
        arguments: String(event.item.arguments ?? current?.arguments ?? ''),
      })
      return
    }
    if (event.type === 'response.completed') {
      usage = toResponsesUsage(event.response?.usage)
      finishReason = calls.size ? 'tool_calls' : 'stop'
      return
    }
    if (event.type === 'response.incomplete') {
      usage = toResponsesUsage(event.response?.usage)
      finishReason = String(event.response?.incomplete_details?.reason || 'incomplete')
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
      })
    }
  }
  return {
    text,
    toolCalls,
    usage: toResponsesUsage(body.usage),
    finishReason: toolCalls.length ? 'tool_calls' : body.status === 'incomplete' ? String(body.incomplete_details?.reason || 'incomplete') : 'stop',
  }
}

export function createProvider({ baseURL, apiKey, model, providerId, fetch: doFetch = fetch, retryDelayMs = 1000 }: ProviderOptions): Provider {
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

      if (useNativeResponses) {
        const nativeTools = responseTools(tools)
        const res = await post(
          '/responses',
          {
            model,
            input: responseInputFromMessages(messages),
            stream: true,
            store: false,
            ...(nativeTools.length ? { tools: nativeTools } : {}),
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
