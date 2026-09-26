import { Box, Text } from 'ink'
import { toolLabel } from '../print'
import { DiffView } from './DiffView'
import { color } from './theme'

const PREVIEW_LINES = 5

export interface ToolBlockProps {
  tool: string
  target: string
  output?: string
  display?: string
  isError?: boolean
  done: boolean
  expanded?: boolean
}

export function ToolBlock({ tool, target, output, display, isError, done, expanded }: ToolBlockProps) {
  const isDiff = !!display && /^\s*\d+ [+\- ] /.test(display)
  const lines = (output ?? '').split('\n')
  const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color={isError ? color('red') : done ? color('green') : color('yellow')}>⎿ </Text>
        <Text bold>{toolLabel(tool)}</Text>
        <Text>{`  ${target}`}</Text>
        {display && !isDiff ? <Text dimColor>{`  (${display})`}</Text> : null}
      </Text>
      {isDiff ? (
        <Box marginLeft={3}>
          <DiffView diff={display!} />
        </Box>
      ) : output && (isError || tool === 'bash') ? (
        <Box flexDirection="column" marginLeft={3}>
          {shown.map((line, i) => (
            <Text key={i} dimColor={!isError} color={isError ? color('red') : undefined}>
              {line}
            </Text>
          ))}
          {lines.length > shown.length ? <Text dimColor>{`… ${lines.length - shown.length} baris lagi (ctrl+o)`}</Text> : null}
        </Box>
      ) : null}
    </Box>
  )
}
