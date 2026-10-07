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
