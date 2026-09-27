import { z } from 'zod'
import { defineTool, type Tool } from './types'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface TodoItem {
  content: string
  status: TodoStatus
}

export class TodoStore {
  items: TodoItem[] = []
  private readonly listeners = new Set<(items: TodoItem[]) => void>()
  set(items: TodoItem[]): void {
    this.items = items
    for (const fn of this.listeners) fn(items)
  }
  subscribe(fn: (items: TodoItem[]) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export function createTodoTool(store: TodoStore): Tool {
  return defineTool({
    name: 'todo_write',
    description:
      'Write the task list for multi-step work (3+ steps). Send the whole list every time; exactly one item in_progress while working. Mark items completed as soon as they are done.',
    schema: z.object({
      todos: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })),
    }),
    kind: 'read',
    target: (input) => `${input.todos.length} item`,
    async run(input) {
      if (input.todos.filter((t) => t.status === 'in_progress').length > 1) {
        return { output: 'Hanya boleh satu item in_progress.', isError: true }
      }
      store.set(input.todos)
      const done = input.todos.filter((t) => t.status === 'completed').length
      return { output: `Todo diperbarui: ${done}/${input.todos.length} selesai.` }
    },
  }) as Tool
}
