/** SGR terminal mouse position (1-based), used only for the live Thinking status. */
export interface MousePress { x: number; y: number }

export function parseMousePress(value: string): MousePress | undefined {
  const start = value.indexOf('\x1b[<')
  if (start < 0) return undefined
  const match = /^<(\d+);(\d+);(\d+)M/.exec(value.slice(start + 2))
  if (!match) return undefined
  const button = Number(match[1])
  if (button !== 0) return undefined // left click only, no drag/wheel/modifiers
  const x = Number(match[2])
  const y = Number(match[3])
  if (x < 1 || y < 1) return undefined
  return { x, y }
}

export function parseCursorPosition(value: string): { row: number; col: number } | undefined {
  const start = value.indexOf('\x1b[')
  if (start < 0) return undefined
  const match = /^(\d+);(\d+)R/.exec(value.slice(start + 2))
  if (!match) return undefined
  const row = Number(match[1])
  const col = Number(match[2])
  if (row < 1 || col < 1) return undefined
  return { row, col }
}

/** Ink returns local element positions, not viewport coordinates. The cursor rests after the live frame. */
export function clickedThinking(
  click: MousePress,
  cursorRow: number,
  rootHeight: number,
  target: { x: number; y: number; width: number; height: number },
): boolean {
  if (!rootHeight || !target.width || !target.height) return false
  const origin = cursorRow - rootHeight + 1
  const row = origin + target.y
  const col = target.x + 1
  // ConPTY reports the cursor one line below Ink's live frame in some
  // Windows Terminal layouts (prompt/spinner reflow). Accept the header at
  // either of the two adjacent rows, never arbitrary summary lines.
  return (click.y === row || click.y === row - 1) &&
    click.x >= col && click.x < col + Math.min(target.width, 72)
}

/** Detect raw SGR wheel packets in a raw stdin data chunk (before ESC is stripped), used to suspend mouse capture. */
export function hasMouseWheelSequence(chunk: string): boolean {
  return chunk.includes('\x1b[') && /\[<?6[4567];\d+;\d+[mM]/.test(chunk)
}

/**
 * Sequence fragments Ink 8 does not recognise (mouse, cursor reports) are dropped when complete, but an incomplete
 * escape is flushed as literal input after ~20 ms. That fragment must never be typed into a prompt or filter.
 */
export function isControlReportFragment(input: string): boolean {
  return (
    /^\[<[\d;]*[mM]?$/.test(input) ||
    /^\[(?:\d+;){2}\d+[mM]$/.test(input) ||
    /^\[(?:\d+;)+\d*R?$/.test(input) ||
    /^\[M[\s\S]{0,3}$/.test(input)
  )
}

/** Tokenize split/coalesced Windows ConPTY SGR presses and cursor reports. */
export function parseThinkingReports(value: string): {
  events: Array<{ type: 'mouse'; press: MousePress } | { type: 'cursor'; cursor: { row: number; col: number } }>
  rest: string
} {
  const events: Array<{ type: 'mouse'; press: MousePress } | { type: 'cursor'; cursor: { row: number; col: number } }> = []
  let offset = 0
  while (true) {
    const start = value.indexOf('\x1b[', offset)
    if (start < 0) break
    // A partial escape at the end must survive to the next stdin chunk.
    const finish = /[a-zA-Z~]/.exec(value.slice(start + 2))
    if (!finish) return { events, rest: value.slice(start) }
    const end = start + 2 + finish.index + 1
    const raw = value.slice(start, end)
    const press = parseMousePress(raw)
    const cursor = parseCursorPosition(raw)
    if (press) events.push({ type: 'mouse', press })
    else if (cursor) events.push({ type: 'cursor', cursor })
    offset = end
  }
  const remaining = value.lastIndexOf('\x1b[')
  if (remaining >= offset) return { events, rest: value.slice(remaining) }
  // A chunk may end with the ESC byte alone, before '[' arrives.
  return { events, rest: value.endsWith('\x1b') ? '\x1b' : '' }
}
