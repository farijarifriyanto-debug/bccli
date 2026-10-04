import { expect, test } from 'vitest'
import { applyEditKey, graphemes, insert, type LineState, lineEnd, lineStart, masked, moveLine, nextBoundary, prevBoundary, splitAtCursor, wordLeft, wordRight } from '../../src/ui/lineEdit'

const at = (value: string, cursor = value.length): LineState => ({ value, cursor })
const mark = (s: LineState) => `${s.value.slice(0, s.cursor)}|${s.value.slice(s.cursor)}`
const press = (s: LineState, input: string, key: Parameters<typeof applyEditKey>[2]) => mark(applyEditKey(s, input, key) ?? s)

test('typing and pasting insert at the cursor, not at the end', () => {
  expect(mark(insert(at('halo dunia', 4), ' indah'))).toBe('halo indah| dunia')
  expect(mark(insert(at('', 0), 'a'))).toBe('a|')
  expect(mark(insert(at('ab', 1), 'line1\nline2'))).toBe('aline1\nline2|b')
})

test('left and right move one character, and stop at the ends', () => {
  expect(press(at('abc'), '', { leftArrow: true })).toBe('ab|c')
  expect(press(at('abc', 0), '', { leftArrow: true })).toBe('|abc')
  expect(press(at('abc', 1), '', { rightArrow: true })).toBe('ab|c')
  expect(press(at('abc'), '', { rightArrow: true })).toBe('abc|')
})

test('a character that is several code units is one step: emoji, flags, skin tones, accents', () => {
  const text = 'a😀b👍🏽c🇮🇩d'
  expect(graphemes(text)).toEqual(['a', '😀', 'b', '👍🏽', 'c', '🇮🇩', 'd'])
  let s = at(text, 0)
  const seen: string[] = []
  while (s.cursor < text.length) {
    s = applyEditKey(s, '', { rightArrow: true }) as LineState
    seen.push(text.slice(0, s.cursor))
  }
  expect(seen.map((p) => graphemes(p).length)).toEqual([1, 2, 3, 4, 5, 6, 7])
  // Backspace removes the whole emoji, not half of it
  expect(press(at('x👍🏽'), '', { backspace: true })).toBe('x|')
  expect(press(at('x🇮🇩y', 5), '', { backspace: true })).toBe('x|y')
  expect(press(at('é', 0), '', { delete: true })).toBe('|') // e + combining accent
  expect(prevBoundary('éx', 3)).toBe(2)
  expect(nextBoundary('éx', 0)).toBe(2)
})

test('backspace deletes before the cursor, delete deletes after it', () => {
  expect(press(at('halo dunia', 4), '', { backspace: true })).toBe('hal| dunia')
  expect(press(at('halo dunia', 4), '', { delete: true })).toBe('halo|dunia')
  expect(press(at('abc', 0), '', { backspace: true })).toBe('|abc')
  expect(press(at('', 0), '', { backspace: true })).toBe('|')
  expect(press(at('', 0), '', { delete: true })).toBe('|')
})

test('Delete at the very end erases backwards, for terminals that send it for Backspace', () => {
  expect(press(at('abc'), '', { delete: true })).toBe('ab|')
})

test('Home and End go to the start and end of the current line', () => {
  const s = at('first\nsecond line\nthird', 10) // inside "second line"
  expect(press(s, '', { home: true })).toBe('first\n|second line\nthird')
  expect(press(s, '', { end: true })).toBe('first\nsecond line|\nthird')
  expect(press(s, 'a', { ctrl: true })).toBe('first\n|second line\nthird')
  expect(press(s, 'e', { ctrl: true })).toBe('first\nsecond line|\nthird')
  expect(lineStart('ab\ncd', 4)).toBe(3)
  expect(lineEnd('ab\ncd', 0)).toBe(2)
})

test('word movement: Ctrl/Alt + arrows, Alt+B/F, and the word-wise deletes', () => {
  const text = 'cari  file   baru.ts'
  expect(wordLeft(text, text.length)).toBe(13)
  expect(wordLeft(text, 13)).toBe(6)
  expect(wordLeft(text, 6)).toBe(0)
  expect(wordRight(text, 0)).toBe(4)
  expect(wordRight(text, 4)).toBe(10)
  expect(press(at(text), '', { leftArrow: true, ctrl: true })).toBe('cari  file   |baru.ts')
  expect(press(at(text, 0), '', { rightArrow: true, meta: true })).toBe('cari|  file   baru.ts')
  expect(press(at(text), 'b', { meta: true })).toBe('cari  file   |baru.ts')
  expect(press(at(text, 0), 'f', { meta: true })).toBe('cari|  file   baru.ts')
  expect(press(at(text), 'w', { ctrl: true })).toBe('cari  file   |')
  expect(press(at(text), '', { backspace: true, meta: true })).toBe('cari  file   |')
  expect(press(at(text, 4), 'd', { meta: true })).toBe('cari|   baru.ts')
})

test('Ctrl+U and Ctrl+K cut to the start and end of the current line only', () => {
  const s = at('one\ntwo three\nfour', 8) // after "two "
  expect(press(s, 'u', { ctrl: true })).toBe('one\n|three\nfour')
  expect(press(s, 'k', { ctrl: true })).toBe('one\ntwo |\nfour')
})

test('Ctrl+B and Ctrl+F are left and right', () => {
  expect(press(at('abc', 1), 'f', { ctrl: true })).toBe('ab|c')
  expect(press(at('abc', 2), 'b', { ctrl: true })).toBe('a|bc')
})

test('keys that are not editing keys are left to the caller', () => {
  expect(applyEditKey(at('abc'), 'x', {})).toBeUndefined()
  expect(applyEditKey(at('abc'), 'x', { ctrl: true })).toBeUndefined()
  expect(applyEditKey(at('abc'), 'x', { meta: true })).toBeUndefined()
  expect(applyEditKey(at('abc'), '', {})).toBeUndefined()
})

test('up and down move between lines of a multi-line text, keeping the column', () => {
  const text = 'abcdef\nxy\nlonger line'
  expect(moveLine(text, 4, 1)).toBe(9) // column 4 does not exist on "xy": the end of that line
  expect(moveLine(text, 9, 1)).toBe(12) // from the end of "xy" (column 2) to column 2 of the last line
  expect(moveLine(text, 12, -1)).toBe(9)
  expect(moveLine(text, 3, -1)).toBeUndefined() // first line: nothing above
  expect(moveLine(text, text.length, 1)).toBeUndefined() // last line: nothing below
  expect(moveLine('single line', 3, 1)).toBeUndefined()
})

test('what is drawn: the character under the cursor, or a space at the end and on a line break', () => {
  expect(splitAtCursor(at('abc', 1))).toEqual({ before: 'a', at: 'b', after: 'c' })
  expect(splitAtCursor(at('abc'))).toEqual({ before: 'abc', at: ' ', after: '' })
  expect(splitAtCursor(at('ab\ncd', 2))).toEqual({ before: 'ab', at: ' ', after: '\ncd' })
  expect(splitAtCursor(at('a👍🏽b', 1))).toEqual({ before: 'a', at: '👍🏽', after: 'b' })
  expect(splitAtCursor(at('', 0))).toEqual({ before: '', at: ' ', after: '' })
})

test('a hidden text keeps the cursor on the right dot', () => {
  expect(masked(at('secret', 3))).toEqual({ value: '••••••', cursor: 3 })
  expect(masked(at('a👍🏽b', 5))).toEqual({ value: '•••', cursor: 2 })
})

test('whatever keys are pressed, the cursor stays inside the text on a character boundary', () => {
  const keys = [{ leftArrow: true }, { rightArrow: true }, { home: true }, { end: true }, { backspace: true }, { delete: true }, { leftArrow: true, ctrl: true }, { rightArrow: true, ctrl: true }]
  let seed = 7
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648)
  let s = at('a😀 bc\n👍🏽 de🇮🇩f')
  for (let i = 0; i < 4000; i++) {
    const r = next() % 12
    s = r < 8 ? ((applyEditKey(s, '', keys[r]) as LineState | undefined) ?? s) : insert(s, ['x', 'é', '😀', '\n', ' '][r - 8] ?? 'x')
    expect(s.cursor).toBeGreaterThanOrEqual(0)
    expect(s.cursor).toBeLessThanOrEqual(s.value.length)
    expect(graphemes(s.value.slice(0, s.cursor)).join('')).toBe(s.value.slice(0, s.cursor)) // no half character before the cursor
    if (s.value.length > 200) s = at('')
  }
})
