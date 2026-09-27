import { Box, Text } from 'ink'
import type { TodoItem } from '../tools/todo'
import { color } from './theme'

const MARK = { completed: '☑', in_progress: '◼', pending: '☐' }

export function TodoList({ items }: { items: TodoItem[] }) {
  if (!items.length || items.every((t) => t.status === 'completed')) return null
  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      {items.map((t, i) => (
        <Text key={i} dimColor={t.status === 'completed'} color={t.status === 'in_progress' ? color('yellow') : undefined}>
          {`${MARK[t.status]} ${t.content}`}
        </Text>
      ))}
    </Box>
  )
}
