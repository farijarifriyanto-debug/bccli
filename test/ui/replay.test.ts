import { expect, test } from 'vitest'
import type { ChatMessage } from '../../src/provider'
import { replayEntries } from '../../src/ui/replay'

test('replayEntries shows every user and assistant text message in order, skipping tool traffic and empty text', () => {
  const history: ChatMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', content: 'file' },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: [{ type: 'text', text: 'third' }] },
    { role: 'assistant', content: '   ' },
  ]
  const rows = replayEntries(history)
  expect(rows).toHaveLength(4)
  expect(rows[0]).toMatchObject({ kind: 'notice' })
  expect(rows.slice(1).map((r) => (r as { text: string }).text)).toEqual(['first', 'second', 'third'])
})
