import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { SLASH_COMMANDS } from '../commands'
import { completeFile } from './complete'
import { color } from './theme'

export interface PromptInputProps {
  disabled?: boolean
  history: string[]
  cwd: string
  onSubmit(text: string): void
}

export function PromptInput({ disabled, history, cwd, onSubmit }: PromptInputProps) {
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)

  useInput(
    (input, key) => {
      if (key.return) {
        if (value.endsWith('\\')) {
          setValue(`${value.slice(0, -1)}\n`)
          return
        }
        const text = value.trim()
        if (!text) return
        setValue('')
        setHistoryIndex(null)
        onSubmit(text)
        return
      }
      if (key.backspace || key.delete) {
        setValue((v) => v.slice(0, -1))
        return
      }
      if (key.upArrow) {
        if (!history.length) return
        const i = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        setHistoryIndex(i)
        setValue(history[i])
        return
      }
      if (key.downArrow) {
        if (historyIndex === null) return
        const i = historyIndex + 1
        setHistoryIndex(i >= history.length ? null : i)
        setValue(i >= history.length ? '' : history[i])
        return
      }
      if (key.tab && !key.shift) {
        setValue((v) => completeFile(v, cwd))
        return
      }
      if (key.ctrl || key.meta || key.escape || key.tab || key.leftArrow || key.rightArrow) return
      setValue((v) => v + input.replace(/\r/g, '\n'))
    },
    { isActive: !disabled },
  )

  const suggestions =
    value.startsWith('/') && !/\s/.test(value) ? SLASH_COMMANDS.filter((c) => c.name.startsWith(value.slice(1))) : []

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={color('gray')} paddingX={1}>
        <Text>
          <Text color={color('green')}>{'> '}</Text>
          {value}
          {disabled ? '' : <Text inverse> </Text>}
        </Text>
      </Box>
      {suggestions.map((s) => (
        <Text key={s.name} dimColor>{`  /${s.name}  ${s.description}`}</Text>
      ))}
    </Box>
  )
}
