export interface UsageCap {
  /** Total tokens (input + output) per session. */
  tokens?: number
  /** Total USD per session; requires `prices`. */
  usd?: number
  /** USD per 1M tokens, keyed by a substring of the model ref (first match wins). */
  prices?: Record<string, { input: number; output: number }>
}

export function priceFor(cap: UsageCap, model: string): { input: number; output: number } | undefined {
  if (!cap.prices) return undefined
  const key = Object.keys(cap.prices).find((k) => model.includes(k))
  return key ? cap.prices[key] : undefined
}

export function budgetStatus(
  usage: { inputTokens: number; outputTokens: number },
  cap: UsageCap | undefined,
  model: string,
): { kind: 'tokens' | 'usd'; used: number; limit: number } | undefined {
  if (!cap) return undefined
  const total = usage.inputTokens + usage.outputTokens
  if (cap.tokens !== undefined && total >= cap.tokens) return { kind: 'tokens', used: total, limit: cap.tokens }
  if (cap.usd !== undefined) {
    const price = priceFor(cap, model)
    if (price) {
      const usd = (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000
      if (usd >= cap.usd) return { kind: 'usd', used: usd, limit: cap.usd }
    }
  }
  return undefined
}
