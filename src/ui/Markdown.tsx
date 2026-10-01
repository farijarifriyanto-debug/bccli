import { Box, Text, useStdout } from 'ink'
import type { ReactNode } from 'react'
import { layoutTable, parseInline, parseTable, type Seg } from './table'
import { color } from './theme'

function segment(seg: Seg, key: number): ReactNode {
  if (seg.style === 'bold') {
    return (
      <Text key={key} bold>
        {seg.text}
      </Text>
    )
  }
  if (seg.style === 'code') {
    return (
      <Text key={key} color={color('cyan')}>
        {seg.text}
      </Text>
    )
  }
  if (seg.style === 'dim') {
    return (
      <Text key={key} dimColor>
        {seg.text}
      </Text>
    )
  }
  return seg.text
}

const inline = (line: string): ReactNode[] => parseInline(line).map(segment)

/**
 * `indent` is how many columns the surrounding UI already uses (a bullet, a border), so tables are sized to
 * what is really left of the terminal width.
 */
export function Markdown({ text, indent = 2 }: { text: string; indent?: number }) {
  const { stdout } = useStdout()
  const width = Math.max(20, (stdout?.columns ?? 80) - indent - 1)
  const lines = text.split('\n')
  const rows: ReactNode[] = []
  let inCode = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      rows.push(
        <Text key={i} color={color('cyan')}>
          {`  ${line}`}
        </Text>,
      )
      continue
    }
    const parsed = parseTable(lines, i)
    if (parsed) {
      layoutTable(parsed.table, width).forEach((tableLine, n) => {
        rows.push(<Text key={`${i}-${n}`}>{tableLine.length ? tableLine.map(segment) : ' '}</Text>)
      })
      i = parsed.end - 1
      continue
    }
    rows.push(<Text key={i}>{line ? inline(line) : ' '}</Text>)
  }
  return <Box flexDirection="column">{rows}</Box>
}
