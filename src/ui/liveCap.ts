/**
 * Live assistant text is drawn inside the Ink frame, so on a real terminal it is capped to the rows left after the
 * prompt and status bar; the hidden part is announced instead of silently dropped. Piped stdout has no rows to
 * respect (`bccli | tee log`, CI harnesses), so the text is kept whole there.
 */
export function capLiveMarkdown(raw: string, options: { isRealTty: boolean; maxLines: number }): string {
  if (!options.isRealTty) return raw
  const lines = raw.split('\n')
  if (lines.length <= options.maxLines) return raw
  const hidden = lines.length - options.maxLines
  const headFence = lines.slice(0, hidden).find((line) => line.trimStart().startsWith('```'))
  const prefix = headFence ? `${headFence}\n… (${hidden} lines above) …\n` : `… (${hidden} lines above) …\n`
  return `${prefix}${lines.slice(-options.maxLines).join('\n')}`
}
