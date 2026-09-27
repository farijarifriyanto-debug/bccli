import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { color } from './theme'

export interface McpMenuItem {
  name: string
  description: string
  status: 'ready' | 'error' | 'starting' | 'off'
  error?: string
  installed: boolean
}

const MARK = { ready: '✓', error: '✗', starting: '…', off: '○' }

export function McpMenu({ items, onPick }: { items: McpMenuItem[]; onPick(name: string | undefined): void }) {
  const [index, setIndex] = useState(0)
  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1))
    else if (key.downArrow) setIndex((i) => Math.min(items.length - 1, i + 1))
    else if (key.return) onPick(items[index]?.name)
    else if (key.escape) onPick(undefined)
  })
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text bold>Server MCP (enter: pasang / hapus · esc tutup) · ✓ aktif ○ belum ✗ error</Text>
      {items.map((item, i) => (
        <Text key={item.name} color={i === index ? color('green') : undefined}>
          {`${i === index ? '›' : ' '} ${MARK[item.status]} ${item.name.padEnd(12)}`}
          <Text dimColor>{item.status === 'error' ? ` ${item.error ?? ''}` : ` ${item.description}`}</Text>
        </Text>
      ))}
    </Box>
  )
}
