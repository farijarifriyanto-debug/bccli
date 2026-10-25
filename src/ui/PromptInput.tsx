import { Box, Text, useInput } from 'ink'
import { useEffect, useRef, useState } from 'react'
import { SLASH_COMMANDS } from '../commands'
import { applyFileSuggestion, completeFile, listFileSuggestions } from './complete'
import { EditableText } from './EditableText'
import { applyEditKey, insert, type LineState, moveLine } from './lineEdit'
import { isControlReportFragment } from './thinkingMouse'
import { applyVim, type VimMode } from './vim'
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
  /** Vim editing: Esc enters normal mode (hjkl/w/b/0/$/x/dd/dw/i/a/A/o/O). */
  vim?: boolean
  /** Called when Tab is pressed on an empty prompt (e.g. to toggle Thinking without Ctrl+T). */
  onEmptyTab?: () => void
}

export function PromptInput({ disabled, history, cwd, onSubmit, extraCommands, injected, vim, onEmptyTab }: PromptInputProps) {
  const [line, setLine] = useState<LineState>({ value: '', cursor: 0 })
  const { value } = line
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const draftRef = useRef('')
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [vimMode, setVimMode] = useState<VimMode>('insert')
  const [vimPending, setVimPending] = useState<string | undefined>(undefined)
  const injectedSeen = useState(0)
  useEffect(() => {
    if (injected && injected.n !== injectedSeen[0]) {
      injectedSeen[1](injected.n)
      setLine((current) => insert(current, injected.text))
      setSelected(0)
    }
  }, [injected, injectedSeen])

  const all = [...SLASH_COMMANDS, ...(extraCommands ?? []).filter((c) => !SLASH_COMMANDS.some((b) => b.name === c.name))]
  const suggestions =
    historyIndex === null && !dismissed && value.startsWith('/') && !/\s/.test(value)
      ? all.filter((c) => c.name.startsWith(value.slice(1))).slice(0, 8)
      : []
  const beforeCursor = value.slice(0, line.cursor)
  const fileSuggestions =
    historyIndex === null && !dismissed && !suggestions.length && /(^|\s)@([^\s]*)$/.test(beforeCursor)
      ? listFileSuggestions(beforeCursor, cwd, 8)
      : []
  const activeCount = suggestions.length || fileSuggestions.length
  const highlighted = Math.min(selected, Math.max(0, activeCount - 1))
  // The cursor goes to the end of text that was not typed here (history, completion, a chosen command).
  const typed = (text: string): LineState => ({ value: text, cursor: text.length })
  const edit = (next: LineState | ((s: LineState) => LineState)) => {
    setLine(next)
    setSelected(0)
    setDismissed(false)
    setHistoryIndex(null)
  }

  useInput(
    (input, key) => {
      if (isControlReportFragment(input)) return
      // While slash suggestions are open, arrows pick one, Enter runs it, Tab completes it, Esc closes it.
      if (suggestions.length) {
        if (key.escape) {
          setDismissed(true)
          return
        }
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
        if (key.return && !key.meta && !key.shift) {
          edit(typed(''))
          setHistoryIndex(null)
          draftRef.current = ''
          onSubmit(`/${suggestions[highlighted].name}`)
          return
        }
      }
      // While @file suggestions are open, arrows pick one, Tab completes it, Esc closes the list.
      if (fileSuggestions.length) {
        if (key.escape) {
          setDismissed(true)
          return
        }
        if (key.upArrow) {
          setSelected(Math.max(0, highlighted - 1))
          return
        }
        if (key.downArrow) {
          setSelected(Math.min(fileSuggestions.length - 1, highlighted + 1))
          return
        }
        if (key.tab && !key.shift) {
          const completed = applyFileSuggestion(beforeCursor, fileSuggestions[highlighted])
          edit({ value: completed + value.slice(line.cursor), cursor: completed.length })
          return
        }
      }
      if (vim) {
        const r = applyVim(line, vimMode, input, key, vimPending)
        if (r.handled) {
          setLine(r.state)
          setVimMode(r.mode)
          setVimPending(r.pending)
          setSelected(0)
          return
        }
      }
      if ((key.return && (key.meta || key.shift)) || (key.ctrl && input.toLowerCase() === 'j') || input === '\n') {
        edit((current) => insert(current, '\n'))
        return
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
        draftRef.current = ''
        setVimMode('insert')
        setVimPending(undefined)
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
        if (historyIndex === null) draftRef.current = value
        const i = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
        setHistoryIndex(i)
        setLine(typed(history[i]))
        return
      }
      if (key.downArrow) {
        if (historyIndex === null) return
        const i = historyIndex + 1
        setHistoryIndex(i >= history.length ? null : i)
        setLine(typed(i >= history.length ? draftRef.current : history[i]))
        return
      }
      if (key.tab && !key.shift) {
        if (!value.trim() && onEmptyTab) {
          onEmptyTab()
          return
        }
        // Completes the @file before the cursor and leaves what follows it alone.
        const before = value.slice(0, line.cursor)
        const completed = completeFile(before, cwd)
        if (completed !== before) edit({ value: completed + value.slice(line.cursor), cursor: completed.length })
        return
      }
      if (key.ctrl || key.meta || key.escape || key.tab) return
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
          {vim && vimMode === 'normal' && <Text color={color('green')}> {t('NORMAL')}</Text>}
        </Text>
      </Box>
      {suggestions.map((s, i) => (
        <Text key={s.name} color={i === highlighted ? color('green') : undefined} dimColor={i !== highlighted}>
          {`${i === highlighted ? '›' : ' '} /${s.name}  ${t(s.description)}`}
        </Text>
      ))}
      {fileSuggestions.map((f, i) => (
        <Text key={f} color={i === highlighted ? color('green') : undefined} dimColor={i !== highlighted}>
          {`${i === highlighted ? '›' : ' '} @${f}`}
        </Text>
      ))}
    </Box>
  )
}
