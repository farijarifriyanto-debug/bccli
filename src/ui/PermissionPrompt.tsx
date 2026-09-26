import { Box, Text, useInput } from 'ink'
import type { PermissionAnswer } from '../agent'
import type { PermissionRequest } from '../permissions'
import { DiffView } from './DiffView'
import { color } from './theme'

const VERB: Record<string, string> = { edit: 'edit', write: 'tulis', bash: 'jalankan', fetch: 'ambil' }

export function PermissionPrompt({
  request,
  onAnswer,
}: {
  request: PermissionRequest & { preview?: string }
  onAnswer: (answer: PermissionAnswer) => void
}) {
  useInput((input, key) => {
    const k = input.toLowerCase()
    if (k === 'y') onAnswer('yes')
    else if (k === 'a') onAnswer('session')
    else if (k === 'n' || key.escape) onAnswer('no')
  })
  const sessionLabel = request.kind === 'edit' ? 'ya untuk semua edit sesi ini' : 'ya untuk sesi ini'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('yellow')} paddingX={1}>
      <Text bold>{`Izinkan ${VERB[request.tool] ?? request.tool} ${request.target}?`}</Text>
      {request.preview ? <DiffView diff={request.preview} /> : null}
      <Text>
        <Text color={color('green')}>[y] ya</Text>
        {'   '}
        <Text color={color('cyan')}>{`[a] ${sessionLabel}`}</Text>
        {'   '}
        <Text color={color('red')}>[n] tidak</Text>
      </Text>
    </Box>
  )
}
