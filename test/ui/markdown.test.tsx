import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { displayWidth } from '../../src/ui/table'
import { Markdown } from '../../src/ui/Markdown'

const TABLE = `Intro line with **bold** and \`code\`.

| Plan | Price | Includes |
|---|---:|---|
| Starter | Rp 0 | Free cloud models and a very long description that has to wrap inside its own column instead of running off the screen |
| Pro | Rp 99.900 | Everything in Starter plus the stronger coding models and a bigger image quota every month |

After the table.`

test('a table is drawn as aligned columns inside the terminal width, other lines are untouched', () => {
  const { lastFrame } = render(<Markdown text={TABLE} />)
  const lines = (lastFrame() ?? '').split('\n')
  expect(lines[0]).toBe('Intro line with bold and code.')
  expect(lines.at(-1)).toBe('After the table.')
  const tableLines = lines.filter((l) => l.includes('│') || l.includes('┼'))
  expect(tableLines.length).toBeGreaterThan(4)
  expect(lines.some((l) => l.includes('|---'))).toBe(false) // no raw markdown separator row left
  expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(100) // ink-testing-library terminals are 100 columns wide
  const bars = (l: string) => [...l].map((ch, i) => (ch === '│' || ch === '┼' ? i : -1)).filter((i) => i >= 0)
  for (const l of tableLines) expect(bars(l)).toEqual(bars(tableLines[0]))
  expect(lines.join('\n')).toContain('Rp 99.900')
})

test('indent leaves room for the surrounding border or bullet', () => {
  const wide = render(<Markdown text={TABLE} />)
  const narrow = render(<Markdown text={TABLE} indent={60} />)
  const widest = (frame?: string) => Math.max(...(frame ?? '').split('\n').map(displayWidth))
  expect(widest(narrow.lastFrame())).toBeLessThan(widest(wide.lastFrame()))
  expect(widest(narrow.lastFrame())).toBeLessThanOrEqual(100 - 60)
})

test('a pipe in ordinary text or in a code block is not a table', () => {
  const { lastFrame } = render(<Markdown text={'Use `a | b` to pipe.\n\n```\ncat x | grep y\n```'} />)
  expect(lastFrame()).toContain('Use a | b to pipe.')
  expect(lastFrame()).toContain('cat x | grep y')
  expect(lastFrame()).not.toContain('│')
})
