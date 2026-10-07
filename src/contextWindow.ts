export const DEFAULT_CONTEXT_WINDOW = 128_000

/**
 * Conservative per-model context windows, matched against the model id (provider prefix ignored).
 * Overestimating invites provider 400s, underestimating only compacts a bit early, so every entry
 * is a floor we are confident about; unknown models keep the conservative default.
 */
const WINDOWS: [RegExp, number][] = [
  // BotConnector's Luna request cap (see LUNA_AUTO_COMPACT_THRESHOLD in provider.ts).
  [/gpt-6-luna/i, 272_000],
  [/claude-(opus|sonnet|haiku)-\d/i, 200_000],
  [/gemini-\d/i, 1_048_576],
]

/** Resolves the context window for a `provider/model` ref; `BCCLI_CONTEXT_WINDOW` overrides everything. */
export function contextWindowFor(modelRef: string, env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.BCCLI_CONTEXT_WINDOW)
  if (Number.isInteger(override) && override > 0) return override
  const model = modelRef.slice(modelRef.indexOf('/') + 1)
  for (const [pattern, window] of WINDOWS) if (pattern.test(model)) return window
  return DEFAULT_CONTEXT_WINDOW
}
