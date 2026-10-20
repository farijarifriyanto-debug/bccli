import { expect, test } from 'vitest'
import { clickedThinking, isMouseControlInput, parseCursorPosition, parseMousePress, parseMouseWheel, parseThinkingReports } from '../../src/ui/thinkingMouse'

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
  const rect = { x: 0, y: 3, width: 90, height: 1 }
  // 8-row Ink frame ending on terminal row 22 starts at terminal row 15.
  expect(clickedThinking({ x: 7, y: 18 }, 22, 8, rect)).toBe(true)
  expect(clickedThinking({ x: 52, y: 18 }, 22, 8, rect)).toBe(true)
  expect(clickedThinking({ x: 7, y: 19 }, 22, 8, rect)).toBe(false)
  expect(clickedThinking({ x: 82, y: 18 }, 22, 8, rect)).toBe(false)
  expect(clickedThinking({ x: 7, y: 17 }, 22, 0, rect)).toBe(false)
})
test('mouse and cursor reports cannot be injected into prompt text', () => {
  expect(isMouseControlInput('[<0;12;17M')).toBe(true)
  expect(isMouseControlInput('[<0;12;17m')).toBe(true)
  expect(isMouseControlInput('[<64;12;17M')).toBe(true)
  expect(isMouseControlInput('[<65;12;17M')).toBe(true)
  expect(isMouseControlInput('[<66;12;17M')).toBe(true)
  expect(isMouseControlInput('[<67;12;17M')).toBe(true)
  expect(isMouseControlInput('[64;12;17M')).toBe(true)
  expect(isMouseControlInput('[<64;12;')).toBe(true)
  expect(isMouseControlInput('[M #!')).toBe(true)
  expect(isMouseControlInput('[<64;1;1M\x1b[<64;1;1M')).toBe(true)
  expect(isMouseControlInput('[22;1R')).toBe(true)
  expect(isMouseControlInput('hello')).toBe(false)
  expect(isMouseControlInput('/thinking')).toBe(false)
  expect(isMouseControlInput('[')).toBe(false)
})

test('parseMouseWheel detects touchpad 2-finger and mouse wheel up/down events', () => {
  expect(parseMouseWheel('[<64;12;17M')).toBe('up')
  expect(parseMouseWheel('[<68;12;17M')).toBe('up')
  expect(parseMouseWheel('[64;12;17M')).toBe('up')
  expect(parseMouseWheel('[<65;12;17M')).toBe('down')
  expect(parseMouseWheel('[<69;12;17M')).toBe('down')
  expect(parseMouseWheel('[65;12;17M')).toBe('down')
  expect(parseMouseWheel('[<66;12;17M')).toBeUndefined()
  expect(parseMouseWheel('[<67;12;17M')).toBeUndefined()
  expect(parseMouseWheel('[<0;12;17M')).toBeUndefined()
  expect(parseMouseWheel('hello')).toBeUndefined()
})


test('coalesced mouse and cursor reports both reach the live disclosure', () => {
  const parsed = parseThinkingReports('\x1b[<0;7;18M\x1b[22;1R')
  expect(parsed.rest).toBe('')
  expect(parsed.events).toEqual([
    { type: 'mouse', press: { x: 7, y: 18 } },
    { type: 'cursor', cursor: { row: 22, col: 1 } },
  ])
})

test('SGR and cursor sequences split across stdin chunks are preserved', () => {
  let out = parseThinkingReports('garbage\x1b[<0;7')
  expect(out.events).toHaveLength(0)
  expect(out.rest).toBe('\x1b[<0;7')
  out = parseThinkingReports(out.rest + ';18M\x1b[22;')
  expect(out.events).toEqual([{ type: 'mouse', press: { x: 7, y: 18 } }])
  expect(out.rest).toBe('\x1b[22;')
  out = parseThinkingReports(out.rest + '1R')
  expect(out.events).toEqual([{ type: 'cursor', cursor: { row: 22, col: 1 } }])
  expect(out.rest).toBe('')
  expect(parseThinkingReports('\x1b').rest).toBe('\x1b')
  expect(parseThinkingReports('\x1b' + '[<0;5;6M').events).toHaveLength(1)
})

test('only Thinking header is clickable, not expanded summary lines', () => {
  const target = { x: 0, y: 3, width: 68, height: 7 }
  expect(clickedThinking({ x: 7, y: 18 }, 22, 8, target)).toBe(true)
  expect(clickedThinking({ x: 7, y: 17 }, 22, 8, target)).toBe(true)
  expect(clickedThinking({ x: 7, y: 19 }, 22, 8, target)).toBe(false)
})
