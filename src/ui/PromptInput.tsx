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
  extraCommands?: { name: string; description: string }[]
}

export function PromptInput({ disabled, history, cwd, onSubmit, extraCommands }: PromptInputProps) {
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [selected, setSelected] = useState(0)

  const all = [...SLASH_COMMANDS, ...(extraCommands ?? []).filter((c) => !SLASH_COMMANDS.some((b) => b.name === c.name))]
  const suggestions = value.startsWith('/') && !/\s/.test(value) ? all.filter((c) => c.name.startsWith(value.slice(1))).slice(0, 8) : []
  const highlighted = Math.min(selected, Math.max(0, suggestions.length - 1))
  const edit = (next: string | ((v: string) => string)) => {
    setValue(next)
    setSelected(0)
  }

  useInput(
    (input, key) => {
      // While slash suggestions are open, arrows pick one, Enter runs it, Tab completes it.
      if (suggestions.length) {
        if (key.upArrow) {
          setSelected(Math.max(0, highlighted - 1))
          return
        }
        if (key.downArrow) {
          setSelected(Math.min(suggestions.length - 1, highlighted + 1))
          return
        }
        if (key.tab && !key.shift) {
          edit(`/${suggestions[highlighted].name} `)
          return
        }
        if (key.return) {
          edit('')
          setHistoryIndex(null)
          onSubmit(`/${suggestions[highlighted].name}`)
          return
        }
      }
      if (key.return) {
        if (value.endsWith('\\')) {
          edit(`${value.slice(0, -1)}\n`)
          return
        }
        const text = value.trim()
        if (!text) return
        edit('')
        setHistoryIndex(null)
        onSubmit(text)
        return
      }
      if (key.backspace || key.delete) {
        edit((v) => v.slice(0, -1))
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
        edit((v) => completeFile(v, cwd))
        return
      }
      if (key.ctrl || key.meta || key.escape || key.tab || key.leftArrow || key.rightArrow) return
      edit((v) => v + input.replace(/\r/g, '\n'))
    },
    { isActive: !disabled },
  )

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={color('gray')} paddingX={1}>
        <Text>
          <Text color={color('green')}>{'> '}</Text>
          {value}
          {disabled ? '' : <Text inverse> </Text>}
        </Text>
      </Box>
      {suggestions.map((s, i) => (
        <Text key={s.name} color={i === highlighted ? color('green') : undefined} dimColor={i !== highlighted}>
          {`${i === highlighted ? '›' : ' '} /${s.name}  ${s.description}`}
        </Text>
      ))}
    </Box>
  )
}
