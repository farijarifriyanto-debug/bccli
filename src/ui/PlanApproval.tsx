import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { PlanDecision } from '../tools/plan'
import { isFocusReport } from './focusReport'
import { Markdown } from './Markdown'
import { isMouseControlInput, parseMouseWheel } from './thinkingMouse'
import { color } from './theme'
import { t } from '../i18n'

const MAX_PLAN_LINES = 16

export function PlanApproval({ plan, onAnswer }: { plan: string; onAnswer(d: PlanDecision): void }) {
  const planLines = plan.split('\n')
  const maxOffset = Math.max(0, planLines.length - MAX_PLAN_LINES)
  const [offset, setOffset] = useState(0)

  useInput((input, key) => {
    const wheel = parseMouseWheel(input)
    if (wheel === 'up') {
      setOffset((o) => Math.max(0, o - 2))
      return
    }
    if (wheel === 'down') {
      setOffset((o) => Math.min(maxOffset, o + 2))
      return
    }
    if (isMouseControlInput(input) || isFocusReport(input)) return
    if (key.upArrow) {
      setOffset((o) => Math.max(0, o - 1))
      return
    }
    if (key.downArrow) {
      setOffset((o) => Math.min(maxOffset, o + 1))
      return
    }
    if (key.pageUp) {
      setOffset((o) => Math.max(0, o - MAX_PLAN_LINES))
      return
    }
    if (key.pageDown) {
      setOffset((o) => Math.min(maxOffset, o + MAX_PLAN_LINES))
      return
    }
    const k = input.toLowerCase()
    if (k === 'a') onAnswer('acceptEdits')
    else if (k === 'y') onAnswer('default')
    else if (k === 'n' || key.escape) onAnswer('no')
  })
  const visiblePlan = planLines.length > MAX_PLAN_LINES ? planLines.slice(offset, offset + MAX_PLAN_LINES).join('\n') : plan
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text bold>{t('Plan from the agent')}</Text>
      <Markdown text={visiblePlan} indent={5} />
      {planLines.length > MAX_PLAN_LINES ? (
        <Text dimColor>{`↑↓ scroll (${offset + 1}–${Math.min(planLines.length, offset + MAX_PLAN_LINES)} / ${planLines.length})`}</Text>
      ) : null}
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
