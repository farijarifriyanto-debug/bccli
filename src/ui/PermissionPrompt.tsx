import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { PermissionAnswer, PermissionAsk } from '../agent'
import { DiffView } from './DiffView'
import { isFocusReport } from './focusReport'
import { isMouseControlInput, parseMouseWheel } from './thinkingMouse'
import { color } from './theme'
import { t } from '../i18n'

const VERB: Record<string, string> = { edit: 'edit', write: 'write', bash: 'run', fetch: 'fetch' }
const MAX_DIFF_LINES = 16

export function PermissionPrompt({
  request,
  onAnswer,
}: {
  request: PermissionAsk
  onAnswer: (answer: PermissionAnswer) => void
}) {
  const diffLines = request.preview ? request.preview.split('\n') : []
  const maxOffset = Math.max(0, diffLines.length - MAX_DIFF_LINES)
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
      setOffset((o) => Math.max(0, o - MAX_DIFF_LINES))
      return
    }
    if (key.pageDown) {
      setOffset((o) => Math.min(maxOffset, o + MAX_DIFF_LINES))
      return
    }
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
  const visibleDiff = diffLines.length > MAX_DIFF_LINES ? diffLines.slice(offset, offset + MAX_DIFF_LINES).join('\n') : request.preview
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('yellow')} paddingX={1}>
      <Text bold>{`${request.agent ? `[${request.agent}] ` : ''}${t('Allow {verb} {target}?', { verb: t(VERB[request.tool] ?? request.tool), target: request.target })}`}</Text>
      {visibleDiff ? <DiffView diff={visibleDiff} /> : null}
      {diffLines.length > MAX_DIFF_LINES ? (
        <Text dimColor>{`↑↓ scroll (${offset + 1}–${Math.min(diffLines.length, offset + MAX_DIFF_LINES)} / ${diffLines.length})`}</Text>
      ) : null}
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
