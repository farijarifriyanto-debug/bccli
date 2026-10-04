// Editing a line of text with a cursor: the keys of a normal shell prompt. Pure functions, so they can be tested
// without a terminal; PromptInput and LinePrompt only wire keys to them and draw the result.
//
// `cursor` is an index into `value` (UTF-16 units) and always sits between two characters as the user sees them
// (a letter with accents, an emoji with a skin tone or a flag is one character, not several).

export interface LineState {
  value: string
  cursor: number
}

export interface EditKey {
  leftArrow?: boolean
  rightArrow?: boolean
  home?: boolean
  end?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Start index of every character as the user sees it, plus the end of the text. */
function boundaries(text: string): number[] {
  const out: number[] = []
  for (const { index } of segmenter.segment(text)) out.push(index)
  out.push(text.length)
  return out
}

export function prevBoundary(text: string, pos: number): number {
  let previous = 0
  for (const b of boundaries(text)) {
    if (b >= pos) return previous
    previous = b
  }
  return previous
}

export function nextBoundary(text: string, pos: number): number {
  for (const b of boundaries(text)) if (b > pos) return b
  return text.length
}

const isSpace = (ch: string) => /\s/.test(ch)

/** Start of the word before the cursor: skips spaces, then the word itself. */
export function wordLeft(text: string, pos: number): number {
  let i = pos
  while (i > 0 && isSpace(text[i - 1])) i--
  while (i > 0 && !isSpace(text[i - 1])) i--
  return i
}

/** End of the word after the cursor: skips spaces, then the word itself. */
export function wordRight(text: string, pos: number): number {
  let i = pos
  while (i < text.length && isSpace(text[i])) i++
  while (i < text.length && !isSpace(text[i])) i++
  return i
}

export const lineStart = (text: string, pos: number): number => text.lastIndexOf('\n', pos - 1) + 1

export function lineEnd(text: string, pos: number): number {
  const i = text.indexOf('\n', pos)
  return i === -1 ? text.length : i
}

/** Which line (0-based) the cursor is on, and how many characters it is from the start of that line. */
function position(text: string, pos: number): { line: number; column: number } {
  const before = text.slice(0, pos)
  const start = lineStart(text, pos)
  return { line: before.split('\n').length - 1, column: boundaries(text.slice(start, pos)).length - 1 }
}

export const lineCount = (text: string): number => text.split('\n').length

/** Moves to the same column one line up or down; undefined when there is no such line. */
export function moveLine(text: string, pos: number, direction: -1 | 1): number | undefined {
  const { line, column } = position(text, pos)
  const lines = text.split('\n')
  const target = line + direction
  if (target < 0 || target >= lines.length) return undefined
  let start = 0
  for (let i = 0; i < target; i++) start += lines[i].length + 1
  const chars = boundaries(lines[target])
  return start + chars[Math.min(column, chars.length - 1)]
}

export const atEnd = (s: LineState): boolean => s.cursor >= s.value.length

export function insert(s: LineState, text: string): LineState {
  return { value: s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), cursor: s.cursor + text.length }
}

function remove(s: LineState, from: number, to: number): LineState {
  return { value: s.value.slice(0, from) + s.value.slice(to), cursor: from }
}

/**
 * The result of an editing key, or undefined when the key is not one of them (Enter, Esc, Tab and the arrows that
 * walk through history belong to the caller). Printable text goes through `insert`.
 */
export function applyEditKey(s: LineState, input: string, key: EditKey): LineState | undefined {
  const { value, cursor } = s
  const word = !!(key.ctrl || key.meta)
  if (key.leftArrow) return { value, cursor: word ? wordLeft(value, cursor) : prevBoundary(value, cursor) }
  if (key.rightArrow) return { value, cursor: word ? wordRight(value, cursor) : nextBoundary(value, cursor) }
  if (key.home) return { value, cursor: lineStart(value, cursor) }
  if (key.end) return { value, cursor: lineEnd(value, cursor) }
  if (key.backspace) {
    if (key.meta) return remove(s, wordLeft(value, cursor), cursor) // Alt+Backspace
    return cursor > 0 ? remove(s, prevBoundary(value, cursor), cursor) : s
  }
  if (key.delete) {
    // At the end there is nothing to delete forward. Some terminals send this key for Backspace, so it erases backwards.
    if (atEnd(s)) return cursor > 0 ? remove(s, prevBoundary(value, cursor), cursor) : s
    return remove(s, cursor, nextBoundary(value, cursor))
  }
  if (key.ctrl) {
    switch (input) {
      case 'a':
        return { value, cursor: lineStart(value, cursor) }
      case 'e':
        return { value, cursor: lineEnd(value, cursor) }
      case 'b':
        return { value, cursor: prevBoundary(value, cursor) }
      case 'f':
        return { value, cursor: nextBoundary(value, cursor) }
      case 'w':
        return remove(s, wordLeft(value, cursor), cursor)
      case 'u':
        return remove(s, lineStart(value, cursor), cursor)
      case 'k':
        return remove(s, cursor, lineEnd(value, cursor))
    }
    return undefined
  }
  if (key.meta) {
    switch (input) {
      case 'b':
        return { value, cursor: wordLeft(value, cursor) }
      case 'f':
        return { value, cursor: wordRight(value, cursor) }
      case 'd':
        return remove(s, cursor, wordRight(value, cursor))
    }
  }
  return undefined
}

/** What to draw: the text before the cursor, the character under it (a space at the end or on a line break), the rest. */
export function splitAtCursor(s: LineState): { before: string; at: string; after: string } {
  const before = s.value.slice(0, s.cursor)
  if (s.cursor >= s.value.length) return { before, at: ' ', after: '' }
  const end = nextBoundary(s.value, s.cursor)
  const char = s.value.slice(s.cursor, end)
  if (char === '\n') return { before, at: ' ', after: s.value.slice(s.cursor) }
  return { before, at: char, after: s.value.slice(end) }
}

/** The characters of a text as the user sees them. */
export const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), (s) => s.segment)

/** The same cursor over a hidden text (an API key): one dot per character. */
export function masked(s: LineState): LineState {
  return { value: '•'.repeat(graphemes(s.value).length), cursor: graphemes(s.value.slice(0, s.cursor)).length }
}
