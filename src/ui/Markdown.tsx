import { Box, Text } from 'ink'
import type { ReactNode } from 'react'
import { color } from './theme'

function inline(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return (
        <Text key={i} bold>
          {part.slice(2, -2)}
        </Text>
      )
    }
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <Text key={i} color={color('cyan')}>
          {part.slice(1, -1)}
        </Text>
      )
    }
    return part
  })
}

export function Markdown({ text }: { text: string }) {
  let inCode = false
  const rows: ReactNode[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('```')) {
      inCode = !inCode
      return
    }
    rows.push(
      inCode ? (
        <Text key={i} color={color('cyan')}>
          {`  ${line}`}
        </Text>
      ) : (
        <Text key={i}>{line ? inline(line) : ' '}</Text>
      ),
    )
  })
  return <Box flexDirection="column">{rows}</Box>
}
