// Markdown tables for the terminal: parse them, size the columns to the available width, wrap long cells
// inside their column, and keep every row aligned. Pure functions; Markdown.tsx only draws the result.

export type Style = 'plain' | 'bold' | 'italic' | 'strike' | 'link' | 'code' | 'dim'
export interface Seg {
  text: string
  style: Style
}
export type Align = 'left' | 'center' | 'right'
export interface TableData {
  header: Seg[][]
  align: Align[]
  rows: Seg[][][]
}

// ---- display width (CJK and emoji take two columns, combining marks none) ----

const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757],
  [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f900, 0x1faff], [0x20000, 0x3fffd],
]
const ZERO: [number, number][] = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xe0100, 0xe01ef],
]
const inRanges = (cp: number, ranges: [number, number][]) => ranges.some(([a, b]) => cp >= a && cp <= b)

export function charWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp < 0x300) return 1
  if (inRanges(cp, ZERO)) return 0
  return inRanges(cp, WIDE) ? 2 : 1
}

export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch.codePointAt(0) as number)
  return width
}

const segsWidth = (segs: Seg[]) => segs.reduce((sum, s) => sum + displayWidth(s.text), 0)

// ---- inline formatting ----

// Leftmost match wins, so `code` shields what is inside it. Emphasis only counts when it hugs the text and is not glued to
// a word, so snake_case_names and 2*3*4 are left alone.
const INLINE =
  /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|!?\[[^\]\n]+\]\([^)\s]+\)|(?<![\w*])\*(?![\s*])[^*\n]+?(?<![\s*])\*(?![\w*])|(?<!\w)_(?![\s_])[^_\n]+?(?<![\s_])_(?!\w))/g

export function parseInline(text: string): Seg[] {
  const segs: Seg[] = []
  for (const part of text.split(INLINE)) {
    if (part === '') continue
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) segs.push({ text: part.slice(1, -1), style: 'code' })
    else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) segs.push({ text: part.slice(2, -2), style: 'bold' })
    else if (part.length > 4 && part.startsWith('~~') && part.endsWith('~~')) segs.push({ text: part.slice(2, -2), style: 'strike' })
    else if (/^!?\[[^\]\n]+\]\([^)\s]+\)$/.test(part)) {
      const m = /^(!?)\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part) as RegExpExecArray
      const [, image, label, url] = m
      // A terminal cannot follow a link, so the address stays visible after the text.
      segs.push({ text: label, style: image ? 'plain' : 'link' })
      if (label !== url && !url.startsWith('#')) segs.push({ text: ` (${url})`, style: 'dim' })
    } else if (part.length > 2 && ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_')))) {
      segs.push({ text: part.slice(1, -1), style: 'italic' })
    } else segs.push({ text: part, style: 'plain' })
  }
  return segs
}

// ---- parsing ----

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let current = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      current += '|'
      i++
    } else if (s[i] === '|') {
      cells.push(current)
      current = ''
    } else current += s[i]
  }
  cells.push(current)
  return cells.map((c) => c.trim())
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const isSeparator = (line: string) => line.includes('|') && SEPARATOR.test(line)

const cell = (raw: string): Seg[] => parseInline(raw.replace(/<br\s*\/?>/gi, '\n'))

/** A table starting at lines[start] (header row, separator row, body rows), or undefined. `end` is the next line to read. */
export function parseTable(lines: string[], start: number): { table: TableData; end: number } | undefined {
  if (start + 1 >= lines.length || !lines[start].includes('|') || !isSeparator(lines[start + 1])) return undefined
  const header = splitRow(lines[start])
  const sep = splitRow(lines[start + 1])
  if (sep.length !== header.length) return undefined
  const body: string[][] = []
  let end = start + 2
  while (end < lines.length && lines[end].trim() && lines[end].includes('|')) body.push(splitRow(lines[end++]))
  // A row with more cells than the header is kept (extra columns), never dropped.
  const columns = Math.max(header.length, ...body.map((r) => r.length))
  const pad = <T>(row: T[], fill: T): T[] => [...row, ...Array.from({ length: columns - row.length }, () => fill)]
  const align = pad(
    sep.map((s): Align => (s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : 'left')),
    'left' as Align,
  )
  return { table: { header: pad(header, '').map(cell), align, rows: body.map((r) => pad(r, '').map(cell)) }, end }
}

// ---- wrapping ----

type Word = Seg[]
type Token = Word | 'br'

function tokenize(segs: Seg[]): Token[] {
  const tokens: Token[] = []
  let word: Word = []
  const endWord = () => {
    if (word.length) tokens.push(word)
    word = []
  }
  for (const seg of segs) {
    for (const piece of seg.text.match(/\n|[^\S\n]+|[^\s]+/g) ?? []) {
      if (piece === '\n') {
        endWord()
        tokens.push('br')
      } else if (/^\s+$/.test(piece)) endWord()
      else word.push({ text: piece, style: seg.style })
    }
  }
  endWord()
  return tokens
}

/** Cuts a word that is wider than the column into column-wide pieces, keeping each piece's style. */
function splitWord(word: Word, width: number): Word[] {
  const pieces: Word[] = []
  let current: Word = []
  let used = 0
  for (const seg of word) {
    let text = ''
    for (const ch of seg.text) {
      const w = charWidth(ch.codePointAt(0) as number)
      if (used + w > width && used > 0) {
        if (text) current.push({ text, style: seg.style })
        pieces.push(current)
        current = []
        text = ''
        used = 0
      }
      text += ch
      used += w
    }
    if (text) current.push({ text, style: seg.style })
  }
  if (current.length) pieces.push(current)
  return pieces
}

function wrap(tokens: Token[], width: number): Seg[][] {
  const lines: Seg[][] = []
  let line: Seg[] = []
  let used = 0
  const flush = () => {
    lines.push(line)
    line = []
    used = 0
  }
  for (const token of tokens) {
    if (token === 'br') {
      flush()
      continue
    }
    const w = segsWidth(token)
    if (w > width) {
      if (used > 0) flush()
      const pieces = splitWord(token, width)
      for (const piece of pieces.slice(0, -1)) {
        line = piece
        flush()
      }
      line = pieces.at(-1) ?? []
      used = segsWidth(line)
    } else if (used === 0) {
      line = [...token]
      used = w
    } else if (used + 1 + w <= width) {
      line.push({ text: ' ', style: 'plain' }, ...token)
      used += 1 + w
    } else {
      flush()
      line = [...token]
      used = w
    }
  }
  flush()
  return lines
}

// ---- layout ----

const SEP = ' │ '
const RULE_JOIN = '─┼─'
const MAX_MIN_WIDTH = 12 // a column never refuses to shrink below this just because of one long word

const dim = (text: string): Seg => ({ text, style: 'dim' })

/** Trailing spaces would push a line that exactly fills the terminal onto a second row. */
function rtrim(line: Seg[]): Seg[] {
  const out = [...line]
  while (out.length) {
    const last = out[out.length - 1]
    const text = last.text.trimEnd()
    if (text) {
      out[out.length - 1] = { ...last, text }
      break
    }
    out.pop()
  }
  return out
}
const bold = (segs: Seg[]): Seg[] => segs.map((s) => (s.style === 'plain' ? { ...s, style: 'bold' } : s))

function pad(segs: Seg[], width: number, align: Align, last: boolean): Seg[] {
  const space = Math.max(0, width - segsWidth(segs))
  const left = align === 'right' ? space : align === 'center' ? Math.floor(space / 2) : 0
  const right = last ? 0 : space - left
  return [...(left ? [{ text: ' '.repeat(left), style: 'plain' as Style }] : []), ...segs, ...(right ? [{ text: ' '.repeat(right), style: 'plain' as Style }] : [])]
}

function columnWidths(table: TableData, available: number): number[] | undefined {
  const columns = table.align.length
  const all = [table.header, ...table.rows]
  const natural: number[] = []
  const minimum: number[] = []
  for (let c = 0; c < columns; c++) {
    let widest = 1
    let longestWord = 1
    for (const row of all) {
      const tokens = tokenize(row[c])
      for (const line of wrap(tokens, Number.POSITIVE_INFINITY)) widest = Math.max(widest, segsWidth(line))
      for (const token of tokens) if (token !== 'br') longestWord = Math.max(longestWord, segsWidth(token))
    }
    natural.push(widest)
    minimum.push(Math.min(longestWord, MAX_MIN_WIDTH, widest))
  }
  if (minimum.reduce((a, b) => a + b, 0) > available) return undefined
  const widths = [...natural]
  let total = widths.reduce((a, b) => a + b, 0)
  while (total > available) {
    // Shrink the widest column that still can; this keeps the columns in proportion.
    let pick = -1
    for (let c = 0; c < columns; c++) if (widths[c] > minimum[c] && (pick < 0 || widths[c] > widths[pick])) pick = c
    if (pick < 0) return undefined
    widths[pick]--
    total--
  }
  return widths
}

/** One block per row, "Header: value" lines: used when the columns cannot fit even at their narrowest. */
function stacked(table: TableData, width: number): Seg[][] {
  const lines: Seg[][] = []
  table.rows.forEach((row, r) => {
    if (r > 0) lines.push([dim('─'.repeat(Math.min(width, 40)))])
    row.forEach((value, c) => {
      const label: Seg[] = [...bold(table.header[c]), { text: ': ', style: 'plain' }, ...value]
      lines.push(...wrap(tokenize(label), width))
    })
  })
  return lines.length ? lines : [bold(table.header.flat())]
}

export function layoutTable(table: TableData, width: number): Seg[][] {
  const columns = table.align.length
  const available = Math.max(columns, width - (columns - 1) * SEP.length)
  const widths = columnWidths(table, available)
  if (!widths) return stacked(table, Math.max(10, width))

  const renderRow = (cells: Seg[][], header: boolean): { lines: Seg[][]; height: number } => {
    const wrapped = cells.map((segs, c) => wrap(tokenize(header ? bold(segs) : segs), widths[c]))
    const height = Math.max(...wrapped.map((w) => w.length))
    const lines: Seg[][] = []
    for (let l = 0; l < height; l++) {
      const line: Seg[] = []
      wrapped.forEach((w, c) => {
        if (c > 0) line.push(dim(SEP))
        line.push(...pad(w[l] ?? [], widths[c], table.align[c], c === columns - 1))
      })
      lines.push(rtrim(line))
    }
    return { lines, height }
  }

  const rule: Seg[] = [dim(widths.map((w) => '─'.repeat(w)).join(RULE_JOIN))]
  const head = renderRow(table.header, true)
  const body = table.rows.map((r) => renderRow(r, false))
  const wrappedRows = body.some((b) => b.height > 1)
  const out: Seg[][] = [...head.lines, rule]
  body.forEach((b, i) => {
    if (wrappedRows && i > 0) out.push(rule)
    out.push(...b.lines)
  })
  return out
}
