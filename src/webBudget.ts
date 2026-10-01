import type { ChatMessage } from './provider'

const KEEP_TOKENS = 40_000
const PRUNE_MIN_TOKENS = 20_000
const STUB = '[old tool result removed:'

const tokens = (text: string) => Math.ceil(text.length / 4)
export const isStub = (content: string) => content.startsWith(STUB)

/**
 * Replaces old `fetch` results with a one-line stub, in one batch and only once they add up to more than
 * PRUNE_MIN_TOKENS, so the prompt prefix (and its cache) changes rarely. The newest KEEP_TOKENS worth stay intact.
 */
export function pruneOldFetches(messages: ChatMessage[]): boolean {
  const urls = new Map<string, string>()
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const c of m.tool_calls ?? []) {
      if (c.function.name !== 'fetch') continue
      try {
        urls.set(c.id, String(JSON.parse(c.function.arguments).url ?? ''))
      } catch {
        urls.set(c.id, '')
      }
    }
  }
  let kept = 0
  let oldTokens = 0
  const old: number[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'tool' || !urls.has(m.tool_call_id) || isStub(m.content)) continue
    kept += tokens(m.content)
    if (kept > KEEP_TOKENS) {
      old.push(i)
      oldTokens += tokens(m.content)
    }
  }
  if (oldTokens <= PRUNE_MIN_TOKENS) return false
  for (const i of old) {
    const m = messages[i] as Extract<ChatMessage, { role: 'tool' }>
    messages[i] = { ...m, content: `${STUB} fetch ${urls.get(m.tool_call_id)}. Fetch it again (use prompt for a focused excerpt) if still needed.]` }
  }
  return true
}

export interface WebBudgetLimits {
  perTurn?: number
  sessionChars?: number
}

export class WebBudget {
  private fetches = 0
  private chars = 0
  private readonly perTurn: number
  private readonly sessionChars: number
  constructor(limits: WebBudgetLimits = {}) {
    this.perTurn = limits.perTurn ?? 8
    this.sessionChars = limits.sessionChars ?? 300_000
  }
  startTurn(): void {
    this.fetches = 0
  }
  /** Gives back a reservation, e.g. when the fetch was served from cache and cost nothing. */
  refund(): void {
    if (this.fetches > 0) this.fetches--
  }
  reset(): void {
    this.fetches = 0
    this.chars = 0
  }
  /** Reserves one fetch; returns the refusal to show the model when over budget. */
  take(): string | undefined {
    if (this.fetches >= this.perTurn) {
      return `Limit of ${this.perTurn} fetches per question reached (each fetch uses the user's tokens). Answer from the results you already have; if that is not enough, tell the user what is still missing.`
    }
    if (this.chars >= this.sessionChars) {
      return `Total web page limit for this session reached (~${Math.round(this.sessionChars / 4000)}k tokens). Answer from the results you already have and ask the user whether to search more.`
    }
    this.fetches++
    return undefined
  }
  record(chars: number): void {
    this.chars += chars
  }
}
