import { markdownRowCount, wrappedRows } from './markdownLayout'

/**
 * Splits a frame budget between the live entries, newest first, so the entry being streamed is never the one dropped.
 * A per-entry cap is not enough: an open thinking block and a streaming answer each fitting the budget still add up
 * to a frame twice as tall as the terminal, and Ink rewrites (and duplicates) such a frame on every render.
 */
export function liveRowCaps(wanted: number[], budget: number): number[] {
  const caps = new Array<number>(wanted.length).fill(0)
  let room = Math.max(0, budget)
  for (let i = wanted.length - 1; i >= 0; i--) {
    const take = Math.max(0, Math.min(wanted[i], room))
    caps[i] = take
    room -= take
  }
  return caps
}

/**
 * Plain-text twin of `capLiveMarkdown`: keeps the tail that fits `maxRows` terminal rows and announces the rest.
 * Used for thinking and tool output, which are drawn as plain wrapped text rather than markdown.
 */
export function capLiveText(raw: string, options: { isRealTty: boolean; maxRows: number; width: number }): string {
  if (!options.isRealTty) return raw
  if (options.maxRows <= 0) return ''
  if (wrappedRows(raw, options.width) <= options.maxRows) return raw
  const lines = raw.split('\n')
  const room = Math.max(1, options.maxRows - 1)
  let kept = 0
  while (kept < lines.length && wrappedRows(lines.slice(lines.length - kept - 1).join('\n'), options.width) <= room) kept++
  const hidden = lines.length - kept
  return `… (${hidden} lines above) …\n${lines.slice(hidden).join('\n')}`
}

/**
 * Live assistant text is drawn inside the Ink frame, so on a real terminal it is capped to the rows left after the
 * prompt and status bar; the hidden part is announced instead of silently dropped. Piped stdout has no rows to
 * respect (`bccli | tee log`, CI harnesses), so the text is kept whole there.
 *
 * The budget is in terminal rows, not source lines: a 40-line answer at 100 columns is 120 rows, and an Ink frame
 * taller than the terminal makes every render rewrite the whole screen, which stamps duplicate copies of the same
 * block into the scrollback.
 */
export function capLiveMarkdown(raw: string, options: { isRealTty: boolean; maxRows: number; width: number }): string {
  if (!options.isRealTty) return raw
  if (options.maxRows <= 0) return ''
  if (markdownRowCount(raw, options.width) <= options.maxRows) return raw
  const lines = raw.split('\n')
  // One row of the budget pays for the notice line, so the tail has to fit in what is left.
  const room = Math.max(1, options.maxRows - 1)
  // The smallest cut whose tail fits. Rows only grow as the tail grows, so a binary search finds it in a few counts.
  let lo = 0
  let hi = lines.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (markdownRowCount(lines.slice(mid).join('\n'), options.width) <= room) hi = mid
    else lo = mid + 1
  }
  if (lo >= lines.length) return `… (${lines.length} lines above) …`
  // A tail that starts inside a code block has to be reopened, or its closing fence would turn everything after it
  // into code.
  const dropped = lines.slice(0, lo)
  const fences = dropped.filter((line) => line.trimStart().startsWith('```'))
  const opener = fences.length % 2 === 1 ? fences.at(-1) : undefined
  return `${opener ? `${opener}\n` : ''}… (${lo} lines above) …\n${lines.slice(lo).join('\n')}`
}
