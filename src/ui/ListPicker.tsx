import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { color } from './theme'

export interface ListItem {
  id: string
  label: string
  hint?: string
  disabled?: boolean
}

const VISIBLE = 12

export function ListPicker({ title, items, onPick }: { title: string; items: ListItem[]; onPick(id?: string): void }) {
  const [filter, setFilter] = useState('')
  const [index, setIndex] = useState(0)
  const shown = items.filter((i) => i.label.toLowerCase().includes(filter.toLowerCase()))
  const cursor = Math.min(index, Math.max(0, shown.length - 1))
  useInput((input, key) => {
    if (key.upArrow) setIndex(Math.max(0, cursor - 1))
    else if (key.downArrow) setIndex(Math.min(shown.length - 1, cursor + 1))
    else if (key.return && !shown[cursor]?.disabled) onPick(shown[cursor]?.id)
    else if (key.escape) onPick(undefined)
    else if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1))
      setIndex(0)
    } else if (!key.ctrl && !key.meta && !key.tab && input) {
      setFilter((f) => f + input)
      setIndex(0)
    }
  })
  const start = Math.max(0, Math.min(cursor - 5, shown.length - VISIBLE))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text bold>{`${title} (↑↓ enter · ketik untuk menyaring${filter ? `: ${filter}` : ''} · esc batal)`}</Text>
      {shown.slice(start, start + VISIBLE).map((item, i) => (
        <Text key={item.id} color={start + i === cursor && !item.disabled ? color('green') : undefined} dimColor={item.disabled}>
          {`${start + i === cursor ? '›' : ' '} ${item.label}`}
          {item.hint ? <Text dimColor>{`   ${item.hint}`}</Text> : null}
        </Text>
      ))}
      {shown.length ? null : <Text dimColor>Tidak ada yang cocok.</Text>}
    </Box>
  )
}
