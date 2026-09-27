import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { color } from './theme'

export interface ProviderEntry {
  id: string
  name: string
  ready: boolean
  baseURL: string
}

export function ProviderMenu({ entries, onPick }: { entries: ProviderEntry[]; onPick(id: string | 'custom' | undefined): void }) {
  const rows = [...entries.map((e) => e.id), 'custom']
  const [index, setIndex] = useState(0)
  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1))
    else if (key.downArrow) setIndex((i) => Math.min(rows.length - 1, i + 1))
    else if (key.return) onPick(rows[index])
    else if (key.escape) onPick(undefined)
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text bold>Provider (↑↓ enter, esc batal) · ✓ siap · ○ butuh API key</Text>
      {entries.map((e, i) => (
        <Text key={e.id} color={i === index ? color('green') : undefined}>
          {`${i === index ? '›' : ' '} ${e.ready ? '✓' : '○'} ${e.name}`}
          <Text dimColor>{`  ${e.baseURL}`}</Text>
        </Text>
      ))}
      <Text color={index === rows.length - 1 ? color('green') : undefined}>{`${index === rows.length - 1 ? '›' : ' '}   Custom…`}</Text>
    </Box>
  )
}
