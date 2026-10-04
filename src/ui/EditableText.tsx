import { Text } from 'ink'
import { type LineState, masked, splitAtCursor } from './lineEdit'

/** A line of text with the cursor drawn where it is (the character under it, or a space at the end, in reverse video). */
export function EditableText({ state, mask = false, showCursor = true }: { state: LineState; mask?: boolean; showCursor?: boolean }) {
  const view = mask ? masked(state) : state
  if (!showCursor) return <>{view.value}</>
  const { before, at, after } = splitAtCursor(view)
  return (
    <>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </>
  )
}
