import { Box, Text, useInput } from 'ink'
import type { PermissionAnswer, PermissionAsk } from '../agent'
import { DiffView } from './DiffView'
import { color } from './theme'
import { t } from '../i18n'

const VERB: Record<string, string> = { edit: 'edit', write: 'write', bash: 'run', fetch: 'fetch' }

export function PermissionPrompt({
  request,
  onAnswer,
}: {
  request: PermissionAsk
  onAnswer: (answer: PermissionAnswer) => void
}) {
  useInput((input, key) => {
    const k = input.toLowerCase()
    if (k === 'y') onAnswer('yes')
    else if (k === 'a' && request.sessionRules?.length) onAnswer('session')
    else if (k === 's') onAnswer('all')
    else if (k === 'n' || key.escape) onAnswer('no')
  })
  // Show exactly what [a] grants; no [a] when the request can never be auto-allowed.
  const rules = request.sessionRules ?? []
  const sessionLabel = !rules.length
    ? null
    : request.kind === 'edit'
      ? t('yes for all edits in this project, this session')
      : t('yes this session for {rules}', { rules: rules.join(', ') })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('yellow')} paddingX={1}>
      <Text bold>{`${request.agent ? `[${request.agent}] ` : ''}${t('Allow {verb} {target}?', { verb: t(VERB[request.tool] ?? request.tool), target: request.target })}`}</Text>
      {request.preview ? <DiffView diff={request.preview} /> : null}
      <Text>
        <Text color={color('green')}>{t('[y] yes')}</Text>
        {'   '}
        {sessionLabel ? <Text color={color('cyan')}>{`[a] ${sessionLabel}   `}</Text> : null}
        <Text color={color('yellow')}>{t('[s] yes to all   ')}</Text>
        <Text color={color('red')}>{t('[n] no')}</Text>
      </Text>
    </Box>
  )
}
