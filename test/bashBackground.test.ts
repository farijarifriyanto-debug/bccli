import { afterEach, expect, test } from 'vitest'
import { createBashTool, renderBackgroundTasks, resetBackgroundTasks } from '../src/tools/bash'

afterEach(() => resetBackgroundTasks())

const ctx = () => ({ cwd: process.cwd(), signal: new AbortController().signal, readFiles: new Set<string>() })
const taskCount = () => (renderBackgroundTasks().match(/^#\d+/gm) ?? []).length

/** Waits until every task in the list has finished, so the retention cap can evict them. */
async function settled(): Promise<void> {
  for (let i = 0; i < 100 && renderBackgroundTasks().includes('[running'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('only the newest finished background tasks are kept once the cap is reached', async () => {
  const tool = createBashTool({ maxRetainedTasks: 2 })
  for (let i = 0; i < 4; i++) {
    await tool.run({ command: `${process.execPath} -e "0"`, background: true }, ctx())
    await settled()
  }

  expect(taskCount()).toBe(2)
  const list = renderBackgroundTasks()
  expect(list).toContain('#4')
  expect(list).not.toContain('#1')
})
