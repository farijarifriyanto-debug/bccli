import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import { color } from './theme'

export function ModelPicker({ models, current, onPick }: { models: string[]; current: string; onPick(model?: string): void }) {
  const [index, setIndex] = useState(Math.max(0, models.indexOf(current)))
  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1))
    else if (key.downArrow) setIndex((i) => Math.min(models.length - 1, i + 1))
    else if (key.return) onPick(models[index])
    else if (key.escape) onPick(undefined)
  })
  const start = Math.max(0, Math.min(index - 5, models.length - 10))
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color('cyan')} paddingX={1}>
      <Text bold>Pilih model (↑↓ enter, esc batal)</Text>
      {models.slice(start, start + 10).map((m, i) => (
        <Text key={m} color={start + i === index ? color('green') : undefined}>
          {`${start + i === index ? '›' : ' '} ${m}${m === current ? '  (aktif)' : ''}`}
        </Text>
      ))}
    </Box>
  )
}
