import { Box, Text, useInput } from 'ink'
import { useEffect, useState } from 'react'
import { SLASH_COMMANDS } from '../commands'
import { completeFile } from './complete'
import { EditableText } from './EditableText'
import { isFocusReport } from './focusReport'
import { applyEditKey, insert, type LineState, moveLine } from './lineEdit'
import { color } from './theme'
import { t } from '../i18n'

export interface PromptInputProps {
  disabled?: boolean
  history: string[]
  cwd: string
  onSubmit(text: string): void
  extraCommands?: { name: string; description: string }[]
  /** Text inserted at the cursor from outside (e.g. a pasted clipboard image path); `n` triggers each insert. */
  injected?: { text: string; n: number }
}

export function PromptInput({ disabled, history, cwd, onSubmit, extraCommands, injected }: PromptInputProps) {
  const [line, setLine] = useState<LineState>({ value: '', cursor: 0 })
  const { value } = line
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [selected, setSelected] = useState(0)
  const injectedSeen = useState(0)
  useEffect(() => {
    if (injected && injected.n !== injectedSeen[0]) {
      injectedSeen[1](injected.n)
      setLine((current) => insert(current, injected.text))
      setSelected(0)
    }
  }, [injected, injectedSeen])

  const all = [...SLASH_COMMANDS, ...(extraCommands ?? []).filter((c) => !SLASH_COMMANDS.some((b) => b.name === c.name))]
  const suggestions = value.startsWith('/') && !/\s/.test(value) ? all.filter((c) => c.name.startsWith(value.slice(1))).slice(0, 8) : []
  const highlighted = Math.min(selected, Math.max(0, suggestions.length - 1))
  // The cursor goes to the end of text that was not typed here (history, completion, a chosen command).
  const typed = (text: string): LineState => ({ value: text, cursor: text.length })
  const edit = (next: LineState | ((s: LineState) => LineState)) => {
    setLine(next)
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
          edit(typed(`/${suggestions[highlighted].name} `))
          return
        }
        if (key.return) {
          edit(typed(''))
          setHistoryIndex(null)
          onSubmit(`/${suggestions[highlighted].name}`)
          return
        }
      }
      if (key.return) {
        // A backslash right before the cursor turns Enter into a line break.
        const before = value.slice(0, line.cursor)
        if (before.endsWith('\\')) {
          edit({ value: `${before.slice(0, -1)}\n${value.slice(line.cursor)}`, cursor: before.length })
          return
        }
        const text = value.trim()
        if (!text) return
        edit(typed(''))
        setHistoryIndex(null)
        onSubmit(text)
        return
      }
      // Cursor movement and editing: arrows, Home/End, Backspace/Delete, Ctrl+A/E/B/F/W/U/K, Alt+B/F/D, word jumps.
      const edited = applyEditKey(line, input, key)
      if (edited) {
        edit((current) => applyEditKey(current, input, key) ?? current)
        return
      }
      if (key.upArrow || key.downArrow) {
        // In a text of several lines the arrows first move between its lines; history starts at the first/last one.
        const moved = moveLine(value, line.cursor, key.upArrow ? -1 : 1)
        if (moved !== undefined) {
          setLine({ value, cursor: moved })
          return
        }
      }
      if (key.upArrow) {
        if (!history.length) return
        const i = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        setHistoryIndex(i)
        setLine(typed(history[i]))
        return
      }
      if (key.downArrow) {
        if (historyIndex === null) return
        const i = historyIndex + 1
        setHistoryIndex(i >= history.length ? null : i)
        setLine(typed(i >= history.length ? '' : history[i]))
        return
      }
      if (key.tab && !key.shift) {
        // Completes the @file before the cursor and leaves what follows it alone.
        const before = value.slice(0, line.cursor)
        const completed = completeFile(before, cwd)
        if (completed !== before) edit({ value: completed + value.slice(line.cursor), cursor: completed.length })
        return
      }
      if (key.ctrl || key.meta || key.escape || key.tab || isFocusReport(input)) return
      const text = input.replace(/\r\n?/g, '\n')
      if (text) edit((current) => insert(current, text))
    },
    { isActive: !disabled },
  )

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={color('gray')} paddingX={1}>
        <Text>
          <Text color={color('green')}>{'> '}</Text>
          <EditableText state={line} showCursor={!disabled} />
        </Text>
      </Box>
      {suggestions.map((s, i) => (
        <Text key={s.name} color={i === highlighted ? color('green') : undefined} dimColor={i !== highlighted}>
          {`${i === highlighted ? '›' : ' '} /${s.name}  ${t(s.description)}`}
        </Text>
      ))}
    </Box>
  )
}
