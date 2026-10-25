import { displayWidth, layoutTable, parseInline, parseTable } from './table'

/**
 * The line shapes `Markdown` draws. They live here so the renderer and the row counter below share one parse order:
 * a drift between the two is what makes a live frame taller than the terminal believes.
 */
export const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
export const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
export const QUOTE = /^\s{0,3}((?:>\s?)+)(.*)$/
export const BULLET = /^(\s*)[-*+]\s+(.*)$/
export const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/
export const BULLETS = ['•', '◦', '▪']

/** Marker width for a list item indented by `spaces`, matching `bulletFor` in Markdown.tsx. */
export const bulletFor = (spaces: number): string => BULLETS[spaces === 0 ? 0 : spaces <= 4 ? 1 : 2]

/** Text rows a single unwrapped line occupies at `width` columns; Ink wraps on spaces, so this is the safe bound. */
export function wrappedRows(text: string, width: number): number {
  const usable = Math.max(1, width)
  const lines = text.split('\n')
  return lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(displayWidth(line) / usable)), 0)
}

/** The text a line actually draws, with the inline markers (`**`, `` ` ``, links) removed. */
const plain = (line: string): string => parseInline(line).map((seg) => seg.text).join('')

/** Rows a marker keep beside its body when the body wraps, using the same width maths as `hanging`. */
const hangingRows = (marker: string, body: string, width: number, padding = 0): number => {
  const textWidth = Math.max(10, width - padding - displayWidth(marker) - 1)
  return wrappedRows(plain(body), textWidth)
}

/**
 * Rows `Markdown` will draw for `text` at `width`. It mirrors the render loop in Markdown.tsx line for line —
 * `markdownLayout.test.ts` renders real markdown and compares, so the two cannot drift unnoticed.
 *
 * A live assistant message has to be sized in the rows it really occupies, not in the lines its source has: at
 * 100 columns a single paragraph is three rows, and a live frame that is taller than the terminal makes Ink rewrite
 * the whole screen on every render, which stamps copies of the same answer into the scrollback.
 */
export function markdownRowCount(text: string, width: number): number {
  const lines = text.split('\n')
  let rows = 0
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      rows += wrappedRows(`  ${line}`, width)
      continue
    }
    const table = parseTable(lines, i)
    if (table) {
      rows += layoutTable(table.table, width).length
      i = table.end - 1
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      rows += wrappedRows(plain(heading[2]), width)
      continue
    }
    if (RULE.test(line)) {
      rows += 1
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote) {
      rows += hangingRows('▎'.repeat(quote[1].replace(/\s/g, '').length), quote[2], width)
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      const padding = Math.min(bullet[1].replace(/\t/g, '    ').length, 16)
      const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[2])
      rows += task
        ? hangingRows(task[1] === ' ' ? '☐' : '☑', task[2], width, padding)
        : hangingRows(bulletFor(padding), bullet[2], width, padding)
      continue
    }
    const numbered = NUMBERED.exec(line)
    if (numbered) {
      const padding = Math.min(numbered[1].replace(/\t/g, '    ').length, 16)
      rows += hangingRows(`${numbered[2]}.`, numbered[3], width, padding)
      continue
    }
    rows += line ? wrappedRows(plain(line), width) : 1
  }
  return rows
}
