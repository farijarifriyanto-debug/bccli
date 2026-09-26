import { Box, Text } from 'ink'
import { color } from './theme'

export function DiffView({ diff }: { diff: string }) {
  return (
    <Box flexDirection="column">
      {diff.split('\n').map((line, i) => {
        const mark = line[6]
        const c = mark === '+' ? color('green') : mark === '-' ? color('red') : undefined
        return (
          <Text key={i} color={c} dimColor={mark !== '+' && mark !== '-'}>
            {line}
          </Text>
        )
      })}
    </Box>
  )
}
