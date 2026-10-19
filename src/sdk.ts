import { parseCliArgs } from './args'
import type { Provider } from './provider'
import { createRuntime } from './setup'

/**
 * Programmatic API: run one bccli task in-process. Permissions are allowAll — the caller
 * is the supervisor. MCP servers are not started; tools are the built-ins + global plugins.
 */
export interface SdkOptions {
  prompt: string
  cwd?: string
  /** provider/model ref, e.g. "bc-cloud/glm-5.3-flash" (default: the config model). */
  model?: string
  provider?: Provider
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  signal?: AbortSignal
}

export interface SdkToolCall {
  name: string
  target: string
  output?: string
  isError?: boolean
}

export interface SdkResult {
  text: string
  toolCalls: SdkToolCall[]
  usage: { inputTokens: number; outputTokens: number }
  stopReason: 'done' | 'stepLimit' | 'aborted' | 'budgetExceeded' | 'error'
  error?: string
}

export type SdkEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'toolStart'; name: string; target: string }
  | { type: 'toolEnd'; name: string; target: string; output: string; isError?: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'result'; result: SdkResult }

export async function* streamTask(opts: SdkOptions): AsyncGenerator<SdkEvent> {
  const args = parseCliArgs([])
  const rt = createRuntime({
    cwd: opts.cwd ?? process.cwd(),
    args: { ...args, allowAll: true, model: opts.model ?? args.model },
    env: opts.env,
    provider: opts.provider,
    fetch: opts.fetch,
  })
  const queue: SdkEvent[] = []
  let wake: (() => void) | null = null
  let finished = false
  let text = ''
  let stopReason: SdkResult['stopReason'] = 'done'
  let errorMessage: string | undefined
  const usage = { inputTokens: 0, outputTokens: 0 }
  const toolCalls: SdkToolCall[] = []
  const byId = new Map<string, SdkToolCall>()
  const push = (e: SdkEvent) => {
    queue.push(e)
    wake?.()
  }
  rt.agent.onEvent = (event) => {
    switch (event.type) {
      case 'text':
        text += event.delta
        push({ type: 'text', delta: event.delta })
        break
      case 'thinking':
        push({ type: 'thinking', delta: event.delta })
        break
      case 'textReplace':
        // recovery replaces everything streamed so far
        text = event.text
        break
      case 'toolStart': {
        const call: SdkToolCall = { name: event.tool, target: event.target }
        byId.set(event.id, call)
        toolCalls.push(call)
        push({ type: 'toolStart', name: event.tool, target: event.target })
        break
      }
      case 'toolEnd': {
        const call = byId.get(event.id)
        if (call) {
          call.output = event.output
          call.isError = event.isError
        }
        push({ type: 'toolEnd', name: event.tool, target: call?.target ?? '', output: event.output, isError: event.isError })
        break
      }
      case 'usage':
        usage.inputTokens = event.inputTokens
        usage.outputTokens = event.outputTokens
        push({ type: 'usage', ...usage })
        break
      case 'stepLimit':
        stopReason = 'stepLimit'
        break
      case 'budgetExceeded':
        stopReason = 'budgetExceeded'
        break
      case 'aborted':
        stopReason = 'aborted'
        break
      case 'error':
        stopReason = 'error'
        errorMessage = event.message
        push({ type: 'error', message: event.message })
        break
      default:
        break
    }
  }
  const controller = new AbortController()
  const onParentAbort = () => controller.abort()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', onParentAbort, { once: true })
  }
  const running = rt.agent
    .run(opts.prompt, controller.signal)
    .catch((err: unknown) => {
      stopReason = 'error'
      errorMessage = err instanceof Error ? err.message : String(err)
    })
    .finally(() => {
      finished = true
      wake?.()
    })
  try {
    while (!finished || queue.length) {
      if (queue.length) {
        yield queue.shift() as SdkEvent
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
      })
      wake = null
    }
    await running
    yield { type: 'result', result: { text, toolCalls, usage, stopReason, ...(errorMessage ? { error: errorMessage } : {}) } }
  } finally {
    opts.signal?.removeEventListener('abort', onParentAbort)
    if (!finished) controller.abort()
  }
}

/** One-shot helper: runs the task and returns only the final result. */
export async function runTask(opts: SdkOptions): Promise<SdkResult> {
  let out: SdkResult = { text: '', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'done' }
  for await (const e of streamTask(opts)) if (e.type === 'result') out = e.result
  return out
}
