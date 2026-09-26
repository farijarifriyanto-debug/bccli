import { structuredPatch } from 'diff'

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  line: number
  text: string
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const patch = structuredPatch('a', 'b', oldText, newText, '', '', { context: 2 })
  const out: DiffLine[] = []
  for (const hunk of patch.hunks) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const raw of hunk.lines) {
      const text = raw.slice(1)
      if (raw[0] === '-') out.push({ kind: 'del', line: oldLine++, text })
      else if (raw[0] === '+') out.push({ kind: 'add', line: newLine++, text })
      else if (raw[0] === ' ') {
        out.push({ kind: 'ctx', line: newLine, text })
        oldLine++
        newLine++
      }
    }
  }
  return out
}

export function formatDiff(lines: DiffLine[]): string {
  const mark = { add: '+', del: '-', ctx: ' ' }
  return lines.map((l) => `${String(l.line).padStart(5)} ${mark[l.kind]} ${l.text}`).join('\n')
}
