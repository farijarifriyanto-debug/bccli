import { lineEnd, lineStart, moveLine, wordLeft, wordRight, type LineState } from './lineEdit'

export type VimMode = 'normal' | 'insert'

/** The subset of ink's key flags applyVim looks at (EditKey is too narrow for Esc/Enter/arrows). */
export interface VimKey {
  escape?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  ctrl?: boolean
  meta?: boolean
  tab?: boolean
  return?: boolean
}

export interface VimResult {
  state: LineState
  mode: VimMode
  /** Set by "d" so the next key picks the text object (dd, dw). */
  pending?: string
  handled: boolean
}

const clamp = (s: LineState): LineState => ({ value: s.value, cursor: Math.min(s.cursor, Math.max(0, s.value.length - 1)) })

/** Vim "w": end of the current word, then skip whitespace to the start of the next one. */
const wordStart = (text: string, pos: number): number => {
  let i = wordRight(text, pos)
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

const deleteLine = (s: LineState): LineState => {
  const from = lineStart(s.value, s.cursor)
  const nl = s.value.indexOf('\n', s.cursor)
  if (nl === -1) {
    // last line: also eat the newline before it, when there is one
    const start = from > 0 ? from - 1 : 0
    return { value: s.value.slice(0, start), cursor: start }
  }
  return { value: s.value.slice(0, from) + s.value.slice(nl + 1), cursor: from }
}

/**
 * Vim key handling for the prompt. Returns handled=false for keys the host input loop
 * should process itself (insert-mode typing, arrows, ctrl/meta combos, Enter).
 */
export function applyVim(s: LineState, mode: VimMode, input: string, key: VimKey, pending?: string): VimResult {
  if (key.escape) return { state: clamp(s), mode: 'normal', handled: true }
  if (mode === 'insert') return { state: s, mode, handled: false }
  // keys the host still owns in normal mode: navigation arrows, modifiers, submit
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.ctrl || key.meta || key.tab || key.return) {
    return { state: s, mode, pending, handled: false }
  }
  if (pending === 'd') {
    if (input === 'd') return { state: deleteLine(s), mode, handled: true }
    if (input === 'w') {
      const to = wordStart(s.value, s.cursor)
      return { state: { value: s.value.slice(0, s.cursor) + s.value.slice(to), cursor: s.cursor }, mode, handled: true }
    }
    // an unknown d-combination is cancelled, not inserted
    return { state: s, mode, handled: true }
  }
  switch (input) {
    case 'h':
      return { state: { ...s, cursor: Math.max(lineStart(s.value, s.cursor), s.cursor - 1) }, mode, handled: true }
    case 'l':
      return { state: { ...s, cursor: Math.min(lineEnd(s.value, s.cursor), s.cursor + 1) }, mode, handled: true }
    case 'j': {
      const moved = moveLine(s.value, s.cursor, 1)
      return { state: moved === undefined ? s : { ...s, cursor: moved }, mode, handled: true }
    }
    case 'k': {
      const moved = moveLine(s.value, s.cursor, -1)
      return { state: moved === undefined ? s : { ...s, cursor: moved }, mode, handled: true }
    }
    case 'w':
      return { state: { ...s, cursor: wordStart(s.value, s.cursor) }, mode, handled: true }
    case 'b':
      return { state: { ...s, cursor: wordLeft(s.value, s.cursor) }, mode, handled: true }
    case '0':
      return { state: { ...s, cursor: lineStart(s.value, s.cursor) }, mode, handled: true }
    case '$':
      return { state: { ...s, cursor: lineEnd(s.value, s.cursor) }, mode, handled: true }
    case 'x': {
      if (s.cursor >= s.value.length || s.value[s.cursor] === '\n') return { state: s, mode, handled: true }
      return { state: { value: s.value.slice(0, s.cursor) + s.value.slice(s.cursor + 1), cursor: s.cursor }, mode, handled: true }
    }
    case 'i':
      return { state: s, mode: 'insert', handled: true }
    case 'a':
      return { state: { ...s, cursor: Math.min(s.cursor + 1, s.value.length) }, mode: 'insert', handled: true }
    case 'A':
      return { state: { ...s, cursor: lineEnd(s.value, s.cursor) }, mode: 'insert', handled: true }
    case 'o': {
      const end = lineEnd(s.value, s.cursor)
      return { state: { value: s.value.slice(0, end) + '\n' + s.value.slice(end), cursor: end + 1 }, mode: 'insert', handled: true }
    }
    case 'O': {
      const start = lineStart(s.value, s.cursor)
      return { state: { value: s.value.slice(0, start) + '\n' + s.value.slice(start), cursor: start }, mode: 'insert', handled: true }
    }
    case 'd':
      return { state: s, mode, pending: 'd', handled: true }
    default:
      // normal mode swallows everything else so it never reaches the buffer
      return { state: s, mode, handled: true }
  }
}
