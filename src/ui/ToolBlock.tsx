import { Box, Text } from 'ink'
import { toolLabel } from '../print'
import { DiffView } from './DiffView'
import type { SubLine } from './transcript'
import { color } from './theme'
import { t } from '../i18n'

const PREVIEW_LINES = 5

export interface ToolBlockProps {
  tool: string
  target: string
  output?: string
  display?: string
  isError?: boolean
  done: boolean
  expanded?: boolean
  sub?: SubLine[]
}

export function ToolBlock({ tool, target, output, display, isError, done, expanded, sub }: ToolBlockProps) {
  const isTask = tool === 'task'
  const isDiff = !!display && /^\s*\d+ [+\- ] /.test(display)
  const lines = (output ?? '').split('\n')
  const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text>
        <Text color={isError ? color('red') : done ? color('green') : color('yellow')}>⎿ </Text>
        <Text bold>{toolLabel(tool)}</Text>
        <Text>{`  ${target}`}</Text>
        {display && !isDiff && !isTask ? <Text dimColor>{`  (${display})`}</Text> : null}
      </Text>
      {sub?.length ? (
        <Box flexDirection="column" marginLeft={3}>
          {sub.slice(-6).map((s) => (
            <Text key={s.id} dimColor={s.done && !s.isError} color={s.isError ? color('red') : undefined}>{`⎿ ${toolLabel(s.tool)}  ${s.target}`}</Text>
          ))}
          {sub.length > 6 ? <Text dimColor>{t('… {n} earlier steps', { n: sub.length - 6 })}</Text> : null}
        </Box>
      ) : null}
      {isTask && done ? (
        <Box marginLeft={3}>
          <Text color={isError ? color('red') : color('green')}>{`${isError ? t('✗ failed') : t('✓ done')}${display ? ` · ${display}` : ''}`}</Text>
        </Box>
      ) : null}
      {isDiff ? (
        <Box marginLeft={3}>
          <DiffView diff={display!} />
        </Box>
      ) : output && (isError || tool === 'bash') && !(isTask && !isError) ? (
        <Box flexDirection="column" marginLeft={3}>
          {shown.map((line, i) => (
            <Text key={i} dimColor={!isError} color={isError ? color('red') : undefined}>
              {line}
            </Text>
          ))}
          {lines.length > shown.length ? <Text dimColor>{t('… {n} more lines (ctrl+o)', { n: lines.length - shown.length })}</Text> : null}
        </Box>
      ) : null}
    </Box>
  )
}
