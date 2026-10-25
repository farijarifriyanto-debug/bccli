export interface UsageCap {
  /** Total tokens (input + output) per session. */
  tokens?: number
  /** Total USD per session; requires `prices`. */
  usd?: number
  /** USD per 1M tokens. `cachedInput` is optional: without it cache reads cost the input price. */
  prices?: Record<string, { input: number; output: number; cachedInput?: number }>
}

export function priceFor(cap: UsageCap, model: string): { input: number; output: number; cachedInput?: number } | undefined {
  if (!cap.prices) return undefined
  const key = Object.keys(cap.prices).find((k) => model.includes(k))
  return key ? cap.prices[key] : undefined
}

export function budgetStatus(
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
  cap: UsageCap | undefined,
  model: string,
): { kind: 'tokens' | 'usd'; used: number; limit: number } | undefined {
  if (!cap) return undefined
  const total = usage.inputTokens + usage.outputTokens
  if (cap.tokens !== undefined && total >= cap.tokens) return { kind: 'tokens', used: total, limit: cap.tokens }
  if (cap.usd !== undefined) {
    const price = priceFor(cap, model)
    if (price) {
      // prompt_tokens already includes cache reads. Billing them at `cachedInput` (when the
      // user listed it) stops the same tokens being charged twice at the full input price.
      const cached = Math.max(0, Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens))
      const cachedRate = price.cachedInput ?? price.input
      const usd =
        ((usage.inputTokens - cached) * price.input + cached * cachedRate + usage.outputTokens * price.output) / 1_000_000
      if (usd >= cap.usd) return { kind: 'usd', used: usd, limit: cap.usd }
    }
  }
  return undefined
}
