import { expect, test } from 'vitest'
import { capLiveMarkdown, capLiveText, liveRowCaps } from '../../src/ui/liveCap'
import { markdownRowCount, wrappedRows } from '../../src/ui/markdownLayout'

const long = Array.from({ length: 30 }, (_, i) => `LINE_${i}`).join('\n')

test('piped (non-TTY) stdout keeps live text whole, however many lines it has', () => {
  expect(capLiveMarkdown(long, { isRealTty: false, maxRows: 14, width: 80 })).toBe(long)
})

test('a real terminal caps the live block to the row budget and says how much is hidden', () => {
  const capped = capLiveMarkdown(long, { isRealTty: true, maxRows: 14, width: 80 })
  expect(capped).toContain('… (17 lines above) …')
  expect(capped).toContain('LINE_29')
  expect(capped).not.toContain('LINE_16')
  expect(markdownRowCount(capped, 80)).toBeLessThanOrEqual(14)
})

test('short live text is never capped, even on a real terminal', () => {
  expect(capLiveMarkdown('LINE_0\nLINE_1', { isRealTty: true, maxRows: 14, width: 80 })).toBe('LINE_0\nLINE_1')
})

test('capping keeps the fence that opened the visible block, so its tail still renders as code', () => {
  const raw = ['```ts', ...Array.from({ length: 30 }, (_, i) => `const n${i} = ${i}`), '```'].join('\n')
  const capped = capLiveMarkdown(raw, { isRealTty: true, maxRows: 10, width: 80 })
  expect(capped.startsWith('```ts\n')).toBe(true)
  expect(capped).toContain('const n29')
})

// The bug this budget exists for: a source line is not a terminal row. 30 paragraphs of 200 columns are 30 lines
// but ~90 rows at 80 columns, and a live frame taller than the terminal makes Ink reprint it on every render.
test('the budget counts wrapped rows, not source lines', () => {
  const paragraph = 'audit prompt menilai kejelasan tujuan, kelengkapan konteks, dan format keluaran yang diminta'
  const raw = Array.from({ length: 30 }, (_, i) => `PARA_${i} ${paragraph}`).join('\n\n')
  const capped = capLiveMarkdown(raw, { isRealTty: true, maxRows: 20, width: 60 })
  expect(wrappedRows(capped, 60)).toBeLessThanOrEqual(20)
  expect(capped).toContain('PARA_29')
})

test('plain text (thinking, tool output) is capped in rows too', () => {
  const text = Array.from({ length: 20 }, (_, i) => `thinking ${i} `.repeat(6)).join('\n')
  const capped = capLiveText(text, { isRealTty: true, maxRows: 12, width: 40 })
  expect(wrappedRows(capped, 40)).toBeLessThanOrEqual(12)
  expect(capped).toContain('thinking 19')
  expect(capped).not.toContain('thinking 0 ')
})

test('an empty budget draws nothing instead of overflowing the frame', () => {
  expect(capLiveMarkdown(long, { isRealTty: true, maxRows: 0, width: 80 })).toBe('')
  expect(capLiveText(long, { isRealTty: true, maxRows: 0, width: 80 })).toBe('')
})

// An open thinking block and a streaming answer each fitting the budget still add up to a frame twice as tall as the
// terminal, so the budget has to be split, not applied per entry.
test('the frame budget is split across live entries, newest first', () => {
  const caps = liveRowCaps([40, 30, 12], 20)
  expect(caps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(20)
  expect(caps[2]).toBe(12)
  expect(caps[1]).toBe(8)
  expect(caps[0]).toBe(0)
})

test('a live entry that fits is left alone', () => {
  expect(liveRowCaps([3, 5], 20)).toEqual([3, 5])
})

test('a budget smaller than the newest entry still keeps its newest rows', () => {
  expect(liveRowCaps([2, 50], 10)).toEqual([0, 10])
})

test('no budget and no room means no live rows at all', () => {
  expect(liveRowCaps([5], 0)).toEqual([0])
  expect(liveRowCaps([5], -3)).toEqual([0])
  expect(liveRowCaps([], 10)).toEqual([])
})
