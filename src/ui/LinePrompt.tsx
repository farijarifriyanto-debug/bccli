import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { isFocusReport } from './focusReport'
import { color } from './theme'

export function LinePrompt({ label, mask, onSubmit, onCancel }: { label: string; mask?: boolean; onSubmit(value: string): void; onCancel(): void }) {
  const [value, setValue] = useState('')
  useInput((input, key) => {
    if (key.return) onSubmit(value.trim())
    else if (key.escape) onCancel()
    else if (key.backspace || key.delete) setValue((v) => v.slice(0, -1))
    else if (!key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow && !isFocusReport(input)) setValue((v) => v + input.replace(/[\r\n]/g, ''))
  })
  const shown = mask ? '•'.repeat(value.length) : value
  return (
    <Box borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text>
        {`${label}: `}
        {shown}
        <Text inverse> </Text>
        <Text dimColor>{'   enter simpan · esc batal'}</Text>
      </Text>
    </Box>
  )
}
