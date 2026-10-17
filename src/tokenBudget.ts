import type { ChatMessage } from './provider'

/** ~4 chars per token, the same conservative estimate the usage fallback uses. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

export const estimateMessages = (messages: ChatMessage[]): number => estimateTokens(JSON.stringify(messages))

/**
 * Drops whole oldest turns (everything up to the next user message) until the history fits the
 * budget. Cutting only at turn boundaries keeps assistant tool_calls paired with their tool
 * replies, so the trimmed history is always valid for a provider request.
 */
export function trimToFit(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  let out = messages
  while (estimateMessages(out) > maxTokens) {
    const boundary = out.findIndex((m, i) => i > 0 && m.role === 'user')
    if (boundary === -1) return out
    out = out.slice(boundary)
  }
  return out
}

/**
 * Splits history into [old, keep]: the newest whole turns that fit `keepTokens` (at least the
 * last user turn) stay verbatim; everything older goes to `old` for summarization. Cutting at
 * user boundaries keeps tool_calls paired with their replies.
 */
export function splitKeepRecent(messages: ChatMessage[], keepTokens: number): [ChatMessage[], ChatMessage[]] {
  if (messages.length === 0) return [[], []]
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if (i > 0 && messages[i].role !== 'user') continue
    if (estimateMessages(messages.slice(i)) <= keepTokens) start = i
    else break
  }
  // Even the last turn alone is over budget: still keep it so the model sees fresh detail.
  if (start === messages.length) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        start = i
        break
      }
    }
  }
  return [messages.slice(0, start), messages.slice(start)]
}

const TOOL_STUB = '[Old tool result content cleared]'
const TOOL_PRUNE_KEEP_TOKENS = 40_000
const TOOL_PRUNE_MIN_TOKENS = 20_000

export const isToolStub = (content: string): boolean => content.startsWith(TOOL_STUB)

/**
 * Replaces old tool results with a one-line stub once they add up past PRUNE_MIN_TOKENS, so the
 * prompt prefix (and its cache) changes rarely. The newest KEEP_TOKENS worth stay intact.
 */
export function pruneOldToolOutputs(messages: ChatMessage[]): boolean {
  let kept = 0
  let oldTokens = 0
  const old: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'tool' || isToolStub(m.content)) continue
    kept += estimateTokens(m.content)
    if (kept > TOOL_PRUNE_KEEP_TOKENS) {
      old.push(i)
      oldTokens += estimateTokens(m.content)
    }
  }
  if (oldTokens <= TOOL_PRUNE_MIN_TOKENS) return false
  for (const i of old) {
    const m = messages[i] as Extract<ChatMessage, { role: 'tool' }>
    messages[i] = { ...m, content: TOOL_STUB }
  }
  return true
}
