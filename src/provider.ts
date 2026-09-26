import type { ToolDefinition } from './tools/index'

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
  usage?: Usage
  finishReason?: string
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  onText?: (delta: string) => void
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

const retryable = (status: number) => status === 429 || status >= 500

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

async function readStream(res: Response, onText?: (delta: string) => void): Promise<Completion> {
  let text = ''
  let usage: Usage | undefined
  let finishReason: string | undefined
  const calls: ToolCall[] = []
  const byIndex = new Map<number, ToolCall>()
  let current: ToolCall | undefined
  const decoder = new TextDecoder()
  let buffer = ''
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    let event: {
      choices?: { delta?: { content?: string; tool_calls?: RawToolCall[] }; finish_reason?: string }[]
      usage?: RawUsage
      error?: { message?: string }
    }
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    if (event.error) throw new ProviderError(`Error dari provider: ${event.error.message ?? JSON.stringify(event.error)}`)
    if (event.usage) usage = toUsage(event.usage)
    const choice = event.choices?.[0]
    if (!choice) return
    if (choice.finish_reason) finishReason = choice.finish_reason
    const delta = choice.delta ?? {}
    if (delta.content) {
      text += delta.content
      onText?.(delta.content)
    }
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
    while (newline >= 0) {
      handle(buffer.slice(0, newline).trim())
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  handle(buffer.trim())
  const toolCalls = calls.map((call, index) => ({ ...call, id: call.id || `call_${index}` }))
  return { text, toolCalls, usage, finishReason }
}

async function readJson(res: Response): Promise<Completion> {
  const body = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: RawToolCall[] }; finish_reason?: string }[]
    usage?: RawUsage
  }
  const choice = body.choices?.[0]
  const toolCalls = (choice?.message?.tool_calls ?? []).map((tc, i) => ({
    id: tc.id || `call_${i}`,
    name: tc.function?.name ?? '',
    arguments: tc.function?.arguments ?? '',
  }))
  return { text: choice?.message?.content ?? '', toolCalls, usage: toUsage(body.usage), finishReason: choice?.finish_reason }
}

export function createProvider({ baseURL, apiKey, model, fetch: doFetch = fetch, retryDelayMs = 1000 }: ProviderOptions): Provider {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let lastError: ProviderError | undefined
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1), signal)
      let res: Response
      try {
        res = await doFetch(`${baseURL}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal })
      } catch (error) {
        if (signal?.aborted) throw error
        lastError = new ProviderError(`Tidak bisa terhubung ke ${baseURL}: ${(error as Error).message}`)
        continue
      }
      if (res.ok) return res
      const text = await res.text().catch(() => '')
      lastError = new ProviderError(`${res.status} dari ${baseURL}: ${errorMessage(text)}`, res.status)
      if (!retryable(res.status)) throw lastError
    }
    throw lastError ?? new ProviderError('Permintaan gagal')
  }

  return {
    async chat({ messages, tools, signal, onText }) {
      const res = await post(
        '/chat/completions',
        { model, messages, stream: true, stream_options: { include_usage: true }, ...(tools?.length ? { tools } : {}) },
        signal,
      )
      if ((res.headers.get('content-type') ?? '').includes('application/json')) return readJson(res)
      if (!res.body) throw new ProviderError('Respons provider kosong')
      return readStream(res, onText)
    },
    async listModels() {
      const res = await doFetch(`${baseURL}/models`, { headers })
      if (!res.ok) throw new ProviderError(`${res.status} saat mengambil daftar model`, res.status)
      const body = (await res.json()) as { data?: { id: string }[] }
      return (body.data ?? []).map((m) => m.id).sort()
    },
  }
}
