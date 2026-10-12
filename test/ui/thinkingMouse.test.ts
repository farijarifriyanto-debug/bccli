import { expect, test } from 'vitest'
import { clickedThinking, isMouseControlInput, parseCursorPosition, parseMousePress } from '../../src/ui/thinkingMouse'

test('SGR accepts only left press and ignores release, wheel and modified clicks', () => {
  expect(parseMousePress('\x1b[<0;12;17M')).toEqual({ x: 12, y: 17 })
  expect(parseMousePress('\x1b[<0;12;17m')).toBeUndefined()
  expect(parseMousePress('\x1b[<64;12;17M')).toBeUndefined()
  expect(parseMousePress('\x1b[<4;12;17M')).toBeUndefined()
  expect(parseMousePress('ordinary text')).toBeUndefined()
})
test('cursor report locates live region; only target row and columns toggle', () => {
  const cursor = parseCursorPosition('\x1b[22;1R')
  expect(cursor).toEqual({ row: 22, col: 1 })
  const rect = { x: 0, y: 3, width: 68, height: 1 }
  // 8-row Ink frame ending on terminal row 22 starts at terminal row 15.
  expect(clickedThinking({ x: 7, y: 18 }, 22, 8, rect)).toBe(true)
  expect(clickedThinking({ x: 7, y: 19 }, 22, 8, rect)).toBe(false)
  expect(clickedThinking({ x: 50, y: 18 }, 22, 8, rect)).toBe(false)
  expect(clickedThinking({ x: 7, y: 17 }, 22, 0, rect)).toBe(false)
})
test('mouse and cursor reports cannot be injected into prompt text', () => {
  expect(isMouseControlInput('[<0;12;17M')).toBe(true)
  expect(isMouseControlInput('[<0;12;17m')).toBe(true)
  expect(isMouseControlInput('[22;1R')).toBe(true)
  expect(isMouseControlInput('hello')).toBe(false)
  expect(isMouseControlInput('/thinking')).toBe(false)
})
