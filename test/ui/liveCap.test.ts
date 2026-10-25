import { expect, test } from 'vitest'
import { capLiveMarkdown } from '../../src/ui/liveCap'

const long = Array.from({ length: 30 }, (_, i) => `LINE_${i}`).join('\n')

test('piped (non-TTY) stdout keeps live text whole, however many lines it has', () => {
  expect(capLiveMarkdown(long, { isRealTty: false, maxLines: 14 })).toBe(long)
})

test('a real terminal caps the live block to the row budget and says how much is hidden', () => {
  const capped = capLiveMarkdown(long, { isRealTty: true, maxLines: 14 })
  expect(capped).toContain('… (16 lines above) …')
  expect(capped).toContain('LINE_29')
  expect(capped).not.toContain('LINE_15')
})

test('short live text is never capped, even on a real terminal', () => {
  expect(capLiveMarkdown('LINE_0\nLINE_1', { isRealTty: true, maxLines: 14 })).toBe('LINE_0\nLINE_1')
})

test('capping keeps the first code fence so the visible tail still renders as code', () => {
  const raw = ['```ts', ...Array.from({ length: 30 }, (_, i) => `const n${i} = ${i}`), '```'].join('\n')
  const capped = capLiveMarkdown(raw, { isRealTty: true, maxLines: 10 })
  expect(capped.startsWith('```ts\n')).toBe(true)
  expect(capped).toContain('const n29')
})
