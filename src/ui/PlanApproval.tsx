import { Box, Text, useInput } from 'ink'
import type { PlanDecision } from '../tools/plan'
import { Markdown } from './Markdown'
import { color } from './theme'
import { t } from '../i18n'

export function PlanApproval({ plan, onAnswer }: { plan: string; onAnswer(d: PlanDecision): void }) {
  useInput((input, key) => {
    const k = input.toLowerCase()
    if (k === 'a') onAnswer('acceptEdits')
    else if (k === 'y') onAnswer('default')
    else if (k === 'n' || key.escape) onAnswer('no')
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text bold>{t('Plan from the agent')}</Text>
      <Markdown text={plan} indent={5} />
      <Text>
        <Text color={color('green')}>{t('[a] yes, auto-edit')}</Text>
        {'   '}
        <Text color={color('cyan')}>{t('[y] yes, ask at each step')}</Text>
        {'   '}
        <Text color={color('red')}>{t('[n] not yet, revise first')}</Text>
      </Text>
    </Box>
  )
}
