import { Box, Text, useInput } from 'ink'
import type { PermissionAnswer, PermissionAsk } from '../agent'
import { DiffView } from './DiffView'
import { color } from './theme'

const VERB: Record<string, string> = { edit: 'edit', write: 'tulis', bash: 'jalankan', fetch: 'ambil' }

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
    else if (k === 'n' || key.escape) onAnswer('no')
  })
  // Show exactly what [a] grants; no [a] when the request can never be auto-allowed.
  const rules = request.sessionRules ?? []
  const sessionLabel = !rules.length
    ? null
    : request.kind === 'edit'
      ? 'ya untuk semua edit di project ini, sesi ini'
      : `ya sesi ini untuk ${rules.join(', ')}`
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('yellow')} paddingX={1}>
      <Text bold>{`Izinkan ${VERB[request.tool] ?? request.tool} ${request.target}?`}</Text>
      {request.preview ? <DiffView diff={request.preview} /> : null}
      <Text>
        <Text color={color('green')}>[y] ya</Text>
        {'   '}
        {sessionLabel ? <Text color={color('cyan')}>{`[a] ${sessionLabel}   `}</Text> : null}
        <Text color={color('red')}>[n] tidak</Text>
      </Text>
    </Box>
  )
}
