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
  return click.y >= row && click.y < row + target.height &&
    click.x >= col && click.x < col + Math.min(target.width, 46)
}

/** Ink useInput receives these control reports too; they must not enter the prompt. */
export function isMouseControlInput(input: string): boolean {
  return /^\[<(?:\d+;){2}\d+[mM]$/.test(input) || /^\[(?:\d+;)\d+R$/.test(input)
}
