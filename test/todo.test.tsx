import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { createTodoTool, TodoStore } from '../src/tools/todo'
import { TodoList } from '../src/ui/TodoList'

const ctx = { cwd: '.', signal: new AbortController().signal, readFiles: new Set<string>() }

test('todo_write replaces the list and notifies subscribers', async () => {
  const store = new TodoStore()
  const seen: number[] = []
  store.subscribe((items) => seen.push(items.length))
  const tool = createTodoTool(store)
  const r = await tool.run(
    { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] },
    ctx,
  )
  expect(r.output).toBe('Todo diperbarui: 1/3 selesai.')
  expect(store.items.map((t) => t.content)).toEqual(['a', 'b', 'c'])
  expect(seen).toEqual([3])
})

test('more than one in_progress item is rejected', async () => {
  const tool = createTodoTool(new TodoStore())
  const r = await tool.run({ todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] }, ctx)
  expect(r.isError).toBe(true)
})

test('TodoList renders checkboxes and hides when done', () => {
  const frame = render(
    <TodoList items={[{ content: 'Baca test', status: 'completed' }, { content: 'Perbaiki', status: 'in_progress' }, { content: 'Jalankan', status: 'pending' }]} />,
  ).lastFrame()!
  expect(frame).toContain('☑ Baca test')
  expect(frame).toContain('◼ Perbaiki')
  expect(frame).toContain('☐ Jalankan')
  expect(render(<TodoList items={[{ content: 'x', status: 'completed' }]} />).lastFrame()).toBe('')
})
