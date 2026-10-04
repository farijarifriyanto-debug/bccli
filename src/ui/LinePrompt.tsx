import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { EditableText } from './EditableText'
import { isFocusReport } from './focusReport'
import { applyEditKey, insert, type LineState } from './lineEdit'
import { color } from './theme'
import { t } from '../i18n'

export function LinePrompt({ label, mask, onSubmit, onCancel }: { label: string; mask?: boolean; onSubmit(value: string): void; onCancel(): void }) {
  const [line, setLine] = useState<LineState>({ value: '', cursor: 0 })
  useInput((input, key) => {
    if (key.return) onSubmit(line.value.trim())
    else if (key.escape) onCancel()
    else if (applyEditKey(line, input, key)) setLine((current) => applyEditKey(current, input, key) ?? current)
    else if (!key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !isFocusReport(input)) {
      const text = input.replace(/[\r\n]/g, '') // a pasted key must stay on one line
      if (text) setLine((current) => insert(current, text))
    }
  })
  return (
    <Box borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text>
        {`${label}: `}
        <EditableText state={line} mask={mask} />
        <Text dimColor>{t('   enter save · esc cancel')}</Text>
      </Text>
    </Box>
  )
}
