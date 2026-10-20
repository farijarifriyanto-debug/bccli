import { Text } from 'ink'
import { type LineState, masked, splitAtCursor } from './lineEdit'

const MAX_VISIBLE_LINES = 10

function windowedState(s: LineState): { view: LineState; hiddenAbove: number; hiddenBelow: number } {
  const lines = s.value.split('\n')
  if (lines.length <= MAX_VISIBLE_LINES) return { view: s, hiddenAbove: 0, hiddenBelow: 0 }
  const cursorLine = s.value.slice(0, s.cursor).split('\n').length - 1
  const startLine = Math.max(0, Math.min(cursorLine - Math.floor(MAX_VISIBLE_LINES / 2), lines.length - MAX_VISIBLE_LINES))
  const endLine = Math.min(lines.length, startLine + MAX_VISIBLE_LINES)
  let charStart = 0
  for (let i = 0; i < startLine; i++) charStart += lines[i].length + 1
  const sliced = lines.slice(startLine, endLine).join('\n')
  const relCursor = Math.max(0, Math.min(sliced.length, s.cursor - charStart))
  return {
    view: { value: sliced, cursor: relCursor },
    hiddenAbove: startLine,
    hiddenBelow: lines.length - endLine,
  }
}

/** A line of text with the cursor drawn where it is (the character under it, or a space at the end, in reverse video). */
export function EditableText({ state, mask = false, showCursor = true }: { state: LineState; mask?: boolean; showCursor?: boolean }) {
  const raw = mask ? masked(state) : state
  const { view, hiddenAbove, hiddenBelow } = windowedState(raw)
  const prefix = hiddenAbove > 0 ? `… (+${hiddenAbove} lines above)\n` : ''
  const suffix = hiddenBelow > 0 ? `\n… (+${hiddenBelow} lines below)` : ''
  if (!showCursor) return <>{`${prefix}${view.value}${suffix}`}</>
  const { before, at, after } = splitAtCursor(view)
  return (
    <>
      {prefix ? <Text dimColor>{prefix}</Text> : null}
      {before}
      <Text inverse>{at}</Text>
      {after}
      {suffix ? <Text dimColor>{suffix}</Text> : null}
    </>
  )
}
