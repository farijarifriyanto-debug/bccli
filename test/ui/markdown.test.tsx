import { Box, Static, Text } from 'ink'
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

const frame = (text: string, indent?: number) => (render(<Markdown text={text} indent={indent} />).lastFrame() ?? '').split('\n')

test('headings lose their # and keep their text', () => {
  expect(frame('# Title\n## Section\n### Detail\nbody')).toEqual(['Title', 'Section', 'Detail', 'body'])
  expect(frame('## With **bold** and `code` ##')).toEqual(['With bold and code'])
  expect(frame('#hashtag is not a heading')).toEqual(['#hashtag is not a heading'])
})

test('lists: bullets, nesting, numbers and tasks', () => {
  expect(frame('- one\n* two\n+ three')).toEqual(['• one', '• two', '• three'])
  expect(frame('- top\n  - nested\n    - deeper')).toEqual(['• top', '  ◦ nested', '    ▪ deeper'])
  // nesting follows however the author indented: 3 spaces under "1. ", 4-space steps, a new list starting fresh
  expect(frame('1. a\n   - b\n   - c\n2. d')).toEqual(['1. a', '   ◦ b', '   ◦ c', '2. d'])
  expect(frame('- a\n    - b\n        - c\n- d')).toEqual(['• a', '    ◦ b', '        ▪ c', '• d'])
  expect(frame('- a\n  - b\n\ntext\n\n- c')).toEqual(['• a', '  ◦ b', '', 'text', '', '• c'])
  expect(frame('1. first\n2. second\n10) tenth')).toEqual(['1. first', '2. second', '10. tenth'])
  expect(frame('- [ ] todo\n- [x] done')).toEqual(['☐ todo', '☑ done'])
  expect(frame('**bold** at the start is not a bullet')).toEqual(['bold at the start is not a bullet'])
})

test('in the app layout a long list item wraps under its text and never overruns the terminal', () => {
  const long = (n: number) => `${n}. ${'word '.repeat(40).trim()}`
  // 100-column test terminal; indent 22 leaves 77 columns, like a bullet plus other chrome would.
  const { lastFrame } = render(
    <Box width={80}>
      <Text>● </Text>
      <Markdown text={`${long(1)}\n- ${'word '.repeat(40).trim()}\n  - ${'word '.repeat(40).trim()}`} indent={22} />
    </Box>,
  )
  const lines = (lastFrame() ?? '').split('\n')
  expect(lines.length).toBeGreaterThan(6)
  expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(80)
  expect(lines[0].startsWith('● 1. word')).toBe(true)
  for (const l of lines.slice(1)) expect(l).toMatch(/^ +(?:[•◦] )?word/) // continuation lines start under the text
  const first = lines.findIndex((l) => l.includes('• word'))
  expect(lines[first + 1]).toMatch(/^ {4}word/) // hanging indent: marker (1) + space (1) + the bullet's own two columns
})

test('quotes get a bar, and rules fill the width', () => {
  expect(frame('> quoted\n>> deeper')).toEqual(['▎ quoted', '▎▎ deeper'])
  const [rule] = frame('---')
  expect(rule).toMatch(/^─+$/)
  expect(frame('***')[0]).toMatch(/^─+$/)
  expect(frame('- - -')[0]).toMatch(/^─+$/)
})

test('inline markers disappear from the text, links keep their address', () => {
  expect(frame('an *italic* ~~old~~ [docs](https://x.dev) and snake_case')).toEqual(['an italic old docs (https://x.dev) and snake_case'])
})

test('inside <Static> (where finished answers are printed) a long list item still stays within the terminal', () => {
  const words = 'word '.repeat(60).trim()
  const { lastFrame } = render(
    <Static items={['x']}>
      {(key) => (
        <Box key={key}>
          <Text>● </Text>
          <Markdown text={`1. ${words}\n- ${words}\n> ${words}`} />
        </Box>
      )}
    </Static>,
  )
  const lines = (lastFrame() ?? '').split('\n')
  expect(lines.length).toBeGreaterThan(6)
  expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(100) // ink-testing-library terminals are 100 columns wide
})
