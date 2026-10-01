import { expect, test } from 'vitest'
import { displayWidth, layoutTable, parseTable, type Seg } from '../../src/ui/table'

const plain = (lines: Seg[][]) => lines.map((l) => l.map((s) => s.text).join(''))
function table(md: string, width: number): string[] {
  const parsed = parseTable(md.trim().split('\n'), 0)
  if (!parsed) throw new Error('not a table')
  return plain(layoutTable(parsed.table, width))
}

// The pricing table from the request, as the model would write it.
const PRICING = `
| Paket | Harga | AI Models Tercakup | Jatah / Allowance Provider Cost | Jendela Penggunaan (Windows) | Kuota Gambar (Image Quota) |
|---|---|---|---|---|---|
| Starter | Rp 0 | Free Cloud dasar (8 model) + Luna (hingga 1 Nov) | Rp 0 (Fair use, non-billable token cap) | Token rolling 24 jam | 10 gambar free/hari |
| Plus | Rp 49.900/bln | 5 model paket + 7 model "Free (Plus+)" + Free dasar | 992.371 µ$ (~$0.99 / ~Rp 17.820) | 5 Jam: 8% (79.390 µ$)Mingguan: 30% (297.711 µ$) | 30 free/hari + 30 hemat/bln |
| Pro | Rp 99.900/bln | 10 model paket (semua model Plus + Gemini 3.8/3.5, GLM-5.2, MiniMax M3, Qwen 397B) + Free (Plus+) | 1.984.741 µ$ (~$1.98 / ~Rp 35.640) | 5 Jam: 10% (198.474 µ$)Mingguan: 33% (654.965 µ$) | 60 free/hari + 60 hemat/bln + 15 menengah/bln |
| Max | Rp 199.000/bln | 12 model paket (semua model Pro + GPT-5.6 Terra, Gemini 3.1 Pro Preview) + Free (Plus+) | 3.969.483 µ$ (~$3.97 / ~Rp 71.280) | 5 Jam: 12% (476.338 µ$)Mingguan: 35% (1.389.319 µ$) | 100 free/hari + 80 hemat/bln + 20 menengah/bln + 10 premium/bln |
`
const WORDS = PRICING.split(/[\s|]+/).filter((w) => w && !/^-+$/.test(w))

// Column boundaries must sit at the same display column on every line of the table.
const separatorColumns = (line: string) => {
  const cols: number[] = []
  let w = 0
  for (const ch of line) {
    if (ch === '│' || ch === '┼') cols.push(w)
    w += displayWidth(ch)
  }
  return cols
}

test('every line fits the width and every column boundary lines up, from wide to narrow terminals', () => {
  for (const width of [200, 160, 120, 100, 80]) {
    const lines = table(PRICING, width)
    expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(width)
    const expected = separatorColumns(lines[0])
    expect(expected.length).toBe(5)
    for (const line of lines.filter((l) => l.includes('│') || l.includes('┼'))) expect(separatorColumns(line)).toEqual(expected)
  }
})

test('no text is lost when cells wrap', () => {
  const rendered = table(PRICING, 90).join(' ')
  for (const word of WORDS) expect(rendered).toContain(word)
})

test('long cells wrap inside their column and the rows are told apart', () => {
  const lines = table(PRICING, 100)
  const isRule = (l: string) => /^─+(─┼──+)+$/.test(l)
  const first = lines.findIndex(isRule)
  expect(first).toBeGreaterThan(0) // a rule under the header (which itself wraps at this width)
  expect(lines.filter(isRule).length).toBeGreaterThan(3) // and between the wrapped rows
  expect(lines.some((l) => l.includes('Gemini 3.8/3.5, GLM-5.2'))).toBe(false) // that phrase had to break across lines
})

test('a table that fits is not padded or wrapped, and has no rules between rows', () => {
  expect(table('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |', 80)).toEqual(['A │ B', '──┼──', '1 │ 2', '3 │ 4'])
})

test('alignment markers: left, center, right', () => {
  expect(table('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |\n| aaaa | bbbb | cccc |', 80)).toEqual([
    'L    │  C   │    R',
    '─────┼──────┼─────',
    'a    │  b   │    c',
    'aaaa │ bbbb │ cccc',
  ])
})

test('inline code and bold do not count towards the width, and keep their style', () => {
  const parsed = parseTable(['| Name | Note |', '|---|---|', '| **bold** | `a` and `b` |'], 0)!
  const lines = layoutTable(parsed.table, 80)
  expect(plain(lines)[2]).toBe('bold │ a and b')
  expect(lines[2].find((s) => s.text === 'bold')?.style).toBe('bold')
  expect(lines[2].find((s) => s.text === 'a')?.style).toBe('code')
})

test('wide characters take two columns, so emoji and CJK rows still line up', () => {
  expect(displayWidth('✅')).toBe(2)
  expect(displayWidth('日本語')).toBe(6)
  expect(displayWidth('é')).toBe(1)
  expect(displayWidth('é')).toBe(1)
  const lines = table('| Status | Item |\n|---|---|\n| ✅ | ok |\n| ❌ | no |\n| 日本 | x |', 80)
  const expected = separatorColumns(lines[0])
  for (const line of lines.filter((l) => l.includes('│'))) expect(separatorColumns(line)).toEqual(expected)
})

test('escaped pipes and <br> inside cells', () => {
  const lines = table('| A | B |\n|---|---|\n| x \\| y | one<br>two |', 80)
  expect(lines).toEqual(['A     │ B', '──────┼────', 'x | y │ one', '      │ two'])
})

test('a word wider than its column is cut instead of overflowing', () => {
  const lines = table('| URL | N |\n|---|---|\n| https://example.com/a/very/long/path/that/never/ends | 1 |', 30)
  expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(30)
  const firstColumn = lines.slice(2).map((l) => l.split('│')[0].trim()).join('')
  expect(firstColumn).toBe('https://example.com/a/very/long/path/that/never/ends')
})

test('when the columns cannot fit at all, each row becomes a block of "Header: value" lines', () => {
  const md = '| Alpha | Beta | Gamma | Delta | Epsilon |\n|---|---|---|---|---|\n| aaaaaaaaaaaa | bbbbbbbbbbbb | cccccccccccc | dddddddddddd | eeeeeeeeeeee |\n| 1 | 2 | 3 | 4 | 5 |'
  const lines = table(md, 30)
  expect(Math.max(...lines.map(displayWidth))).toBeLessThanOrEqual(30)
  expect(lines).toContain('Alpha: aaaaaaaaaaaa')
  expect(lines).toContain('Epsilon: 5')
  expect(lines.some((l) => l.includes('│'))).toBe(false)
})

test('what is not a table is left alone', () => {
  expect(parseTable(['just | a line', 'with a pipe'], 0)).toBeUndefined()
  expect(parseTable(['| a | b |', '|---|'], 0)).toBeUndefined() // separator with a different number of cells
  expect(parseTable(['---', 'text'], 0)).toBeUndefined()
  expect(parseTable(['| only header |'], 0)).toBeUndefined()
})

test('rows with a different number of cells are padded; extra cells are kept', () => {
  expect(table('| A | B |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |', 80)).toEqual(['A │ B │', '──┼───┼──', '1 │   │', '1 │ 2 │ 3'])
})

test('a header-only table (still streaming) draws just the header and rule', () => {
  expect(table('| A | B |\n|---|---|', 80)).toEqual(['A │ B', '──┼──'])
})

import { parseInline } from '../../src/ui/table'

const styled = (text: string) => parseInline(text).map((s) => `${s.style}:${s.text}`)

test('inline: bold, italic, strike, code, links and images', () => {
  expect(styled('a **b** c')).toEqual(['plain:a ', 'bold:b', 'plain: c'])
  expect(styled('an *italic* word and _this one_ too')).toEqual(['plain:an ', 'italic:italic', 'plain: word and ', 'italic:this one', 'plain: too'])
  expect(styled('~~old~~ new')).toEqual(['strike:old', 'plain: new'])
  expect(styled('run `a *b* c` now')).toEqual(['plain:run ', 'code:a *b* c', 'plain: now']) // code shields its content
  expect(styled('see [the docs](https://x.dev/a) now')).toEqual(['plain:see ', 'link:the docs', 'dim: (https://x.dev/a)', 'plain: now'])
  expect(styled('[https://x.dev](https://x.dev)')).toEqual(['link:https://x.dev']) // no repeated address
  expect(styled('![logo](https://x.dev/l.png)')).toEqual(['plain:logo', 'dim: (https://x.dev/l.png)'])
})

test('inline: things that only look like emphasis are left alone', () => {
  expect(styled('snake_case_name and my_var_2')).toEqual(['plain:snake_case_name and my_var_2'])
  expect(styled('2*3*4 and 5 * 6 * 7')).toEqual(['plain:2*3*4 and 5 * 6 * 7'])
  expect(styled('a * b')).toEqual(['plain:a * b'])
  expect(styled('**unclosed and *also')).toEqual(['plain:**unclosed and *also'])
  expect(styled('glob **/*.ts here')).toEqual(['plain:glob **/*.ts here'])
})
