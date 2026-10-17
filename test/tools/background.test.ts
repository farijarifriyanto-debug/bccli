import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, beforeEach } from 'vitest'
import { bashTool, killAllCommands, renderBackgroundTasks, resetBackgroundTasks } from '../../src/tools/bash'
import { SLASH_COMMANDS } from '../../src/commands'

const cwd = mkdtempSync(join(tmpdir(), 'bccli-bg-'))
const node = (code: string) => `node -e "${code}"`
const ctx = () => ({ cwd, signal: new AbortController().signal, readFiles: new Set<string>() })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const idOf = (output: string) => Number(/#(\d+)/.exec(output)?.[1])

beforeEach(() => {
  resetBackgroundTasks()
})

test('background: true returns immediately with a task id', async () => {
  const started = Date.now()
  const r = await bashTool.run({ command: node('setTimeout(()=>{}, 30000)'), background: true }, ctx())
  expect(Date.now() - started).toBeLessThan(3000)
  expect(r.output).toMatch(/Background task #\d+ started/)
  expect(r.isError).toBeFalsy()
  await bashTool.run({ task_id: idOf(r.output), kill: true }, ctx())
})

test('polling a finished background task shows its output and exit code', async () => {
  const start = await bashTool.run({ command: node("process.stdout.write('hello-bg'); process.exit(7)"), background: true }, ctx())
  const id = idOf(start.output)
  let poll = await bashTool.run({ task_id: id }, ctx())
  for (let i = 0; i < 50 && !poll.output.includes('[exit code 7]'); i++) {
    await sleep(100)
    poll = await bashTool.run({ task_id: id }, ctx())
  }
  expect(poll.output).toContain('hello-bg')
  expect(poll.output).toContain('[exit code 7]')
  expect(poll.isError).toBe(true)
})

test('polling an unknown task id is an error', async () => {
  const r = await bashTool.run({ task_id: 99 }, ctx())
  expect(r.isError).toBe(true)
  expect(r.output).toContain('No background task #99')
})

test('kill stops a running background task', async () => {
  const start = await bashTool.run({ command: node('setTimeout(()=>{}, 60000)'), background: true }, ctx())
  const id = idOf(start.output)
  const k = await bashTool.run({ task_id: id, kill: true }, ctx())
  expect(k.output).toContain('Killed')
  let poll = await bashTool.run({ task_id: id }, ctx())
  for (let i = 0; i < 50 && !poll.output.includes('[killed]'); i++) {
    await sleep(100)
    poll = await bashTool.run({ task_id: id }, ctx())
  }
  expect(poll.output).toContain('[killed]')
})

test('bash without command or task_id explains what is missing', async () => {
  const r = await bashTool.run({}, ctx())
  expect(r.isError).toBe(true)
  expect(r.output).toContain('command')
})

test('renderBackgroundTasks lists started tasks and the empty state', async () => {
  expect(renderBackgroundTasks()).toContain('No background tasks')
  const start = await bashTool.run({ command: node("process.stdout.write('out-one')"), background: true }, ctx())
  const id = idOf(start.output)
  let poll = await bashTool.run({ task_id: id }, ctx())
  for (let i = 0; i < 50 && !poll.output.includes('[exit code'); i++) {
    await sleep(100)
    poll = await bashTool.run({ task_id: id }, ctx())
  }
  const text = renderBackgroundTasks()
  expect(text).toContain(`#${id}`)
  expect(text).toContain('out-one')
  await bashTool.run({ task_id: id, kill: true }, ctx())
})

test('killAllCommands also stops background tasks (used on exit / Ctrl+C)', async () => {
  const start = await bashTool.run({ command: node('setTimeout(()=>{}, 60000)'), background: true }, ctx())
  const id = idOf(start.output)
  killAllCommands()
  let poll = await bashTool.run({ task_id: id }, ctx())
  for (let i = 0; i < 50 && !poll.output.includes('[killed]'); i++) {
    await sleep(100)
    poll = await bashTool.run({ task_id: id }, ctx())
  }
  expect(poll.output).toContain('[killed]')
})

test('/tasks slash command is registered', () => {
  expect(SLASH_COMMANDS.some((c) => c.name === 'tasks')).toBe(true)
})
