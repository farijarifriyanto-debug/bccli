import { Box, Text, useInput } from 'ink'
import type { PlanDecision } from '../tools/plan'
import { Markdown } from './Markdown'
import { color } from './theme'

export function PlanApproval({ plan, onAnswer }: { plan: string; onAnswer(d: PlanDecision): void }) {
  useInput((input, key) => {
    const k = input.toLowerCase()
    if (k === 'a') onAnswer('acceptEdits')
    else if (k === 'y') onAnswer('default')
    else if (k === 'n' || key.escape) onAnswer('no')
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text bold>Rencana dari agent</Text>
      <Markdown text={plan} />
      <Text>
        <Text color={color('green')}>[a] ya, edit otomatis</Text>
        {'   '}
        <Text color={color('cyan')}>[y] ya, tanya tiap langkah</Text>
        {'   '}
        <Text color={color('red')}>[n] belum, perbaiki dulu</Text>
      </Text>
    </Box>
  )
}
