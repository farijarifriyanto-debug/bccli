import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { z } from 'zod'
import { collectUntilAbort } from '../src/abort'
import { Agent, type AgentEvent } from '../src/agent'
import { Permissions } from '../src/permissions'
import type { Completion, Provider } from '../src/provider'
import { grepJs } from '../src/tools/grep'
import { ALL_TOOLS } from '../src/tools/index'
import { defineTool } from '../src/tools/types'

const call = (name: string, args: unknown, id: string) => ({ id, name, arguments: JSON.stringify(args) })
const scripted = (steps: Completion[]): Provider => ({
  async chat() {
    const next = steps.shift()
    if (!next) throw new Error('script exhausted')
    return next
  },
  async listModels() {
    return []
  },
})

/** A tool that takes `ms` and never looks at the abort signal: what glob, grep, MCP tools or a subagent can look like. */
const stubborn = (ms: number, finished: { value: boolean }, parallel = false) =>
  defineTool({
    name: 'slow',
    description: 'slow tool that ignores the abort signal',
    schema: z.object({}),
    kind: 'read',
    ...(parallel ? { parallelSafe: () => true } : {}),
    target: () => 'slow',
    async run() {
      await new Promise((r) => setTimeout(r, ms))
      finished.value = true
      return { output: 'finished late' }
    },
  })

function setup(steps: Completion[], tools = ALL_TOOLS) {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-cancel-'))
  const events: AgentEvent[] = []
  const agent = new Agent({ provider: scripted(steps), tools, permissions: new Permissions('allowAll', [], cwd), systemPrompt: 'SYS', cwd })
  agent.onEvent = (e) => events.push(e)
  return { cwd, events, agent }
}

test('Esc during tools that ignore the abort signal stops the turn at once instead of waiting for them', async () => {
  const finished = { value: false }
  const { agent, events } = setup(
    [{ text: '', toolCalls: [call('slow', {}, 'a'), call('slow', {}, 'b')] }, { text: 'never', toolCalls: [] }],
    [stubborn(1500, finished, true) as never], // parallel: both are running when Esc is pressed
  )
  const controller = new AbortController()
  const started = Date.now()
  const run = agent.run('go', controller.signal)
  setTimeout(() => controller.abort(), 100)
  await run
  expect(Date.now() - started).toBeLessThan(800) // not the 1500 ms the tools take
  expect(events.map((e) => e.type)).toContain('aborted')
  expect(events.map((e) => e.type)).not.toContain('done')
  // every tool call still has an answer, so the history stays valid for the next turn
  const answers = agent.messages.filter((m) => m.role === 'tool')
  expect(answers.map((m) => (m.role === 'tool' ? m.tool_call_id : ''))).toEqual(['a', 'b'])
  expect(answers.every((m) => m.role === 'tool' && /Cancelled/.test(m.content))).toBe(true)
  // the tool blocks on screen are closed, not left spinning
  const ended = events.filter((e) => e.type === 'toolEnd').map((e) => (e.type === 'toolEnd' ? e.id : ''))
  expect(ended.sort()).toEqual(['a', 'b'])
  // and when the abandoned tools finally return, nothing leaks into the conversation or the screen
  await new Promise((r) => setTimeout(r, 1500))
  expect(finished.value).toBe(true)
  expect(agent.messages.filter((m) => m.role === 'tool').length).toBe(2)
  expect(events.filter((e) => e.type === 'toolEnd').length).toBe(2)
})

test('calls that had not started yet are answered as cancelled and never show up on screen', async () => {
  const finished = { value: false }
  const { agent, events } = setup(
    [{ text: '', toolCalls: [call('slow', {}, 'a'), call('slow', {}, 'b')] }, { text: 'never', toolCalls: [] }],
    [stubborn(1000, finished) as never], // sequential: only 'a' is running
  )
  const controller = new AbortController()
  const run = agent.run('go', controller.signal)
  setTimeout(() => controller.abort(), 80)
  await run
  const answers = agent.messages.filter((m) => m.role === 'tool')
  expect(answers.map((m) => (m.role === 'tool' ? m.tool_call_id : ''))).toEqual(['a', 'b'])
  expect(events.filter((e) => e.type === 'toolStart').map((e) => (e.type === 'toolStart' ? e.id : ''))).toEqual(['a'])
  expect(events.filter((e) => e.type === 'toolEnd').map((e) => (e.type === 'toolEnd' ? e.id : ''))).toEqual(['a'])
})

test('a tool that is abandoned in one turn cannot touch the next turn, even with the same call id', async () => {
  const finished = { value: false }
  const { agent, events } = setup(
    [{ text: '', toolCalls: [call('slow', {}, 'call_0')] }, { text: '', toolCalls: [call('slow', {}, 'call_0')] }, { text: 'done', toolCalls: [] }],
    [stubborn(400, finished, true) as never],
  )
  const first = new AbortController()
  const one = agent.run('one', first.signal)
  setTimeout(() => first.abort(), 50)
  await one
  const second = agent.run('two', new AbortController().signal) // starts a new call_0 while the old one is still running
  await new Promise((r) => setTimeout(r, 500)) // the old call_0 finishes in the middle of the second turn
  await second
  const ends = events.filter((e) => e.type === 'toolEnd')
  expect(ends.map((e) => (e.type === 'toolEnd' ? e.output : ''))).toEqual(['Cancelled by the user.', 'finished late'])
  expect(events.at(-1)?.type).toBe('done')
})

test('after a cancelled tool the next turn works', async () => {
  const finished = { value: false }
  const { agent, events } = setup(
    [{ text: '', toolCalls: [call('slow', {}, 'a')] }, { text: 'second answer', toolCalls: [] }],
    [stubborn(300, finished) as never],
  )
  const first = new AbortController()
  const run = agent.run('one', first.signal)
  setTimeout(() => first.abort(), 50)
  await run
  await agent.run('two', new AbortController().signal)
  expect(events.at(-1)?.type).toBe('done')
  expect(agent.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'second answer' })
})

function tree(files: number, perDir = 100): string {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-tree-'))
  for (let d = 0; d * perDir < files; d++) {
    mkdirSync(join(cwd, `d${d}`))
    for (let f = 0; f < perDir; f++) writeFileSync(join(cwd, `d${d}`, `f${f}.txt`), 'needle\n')
  }
  return cwd
}
const ctx = (cwd: string, signal: AbortSignal) => ({ cwd, signal, readFiles: new Set<string>(), callId: 'x', emit: () => {}, ask: async () => 'yes' as const }) as never

test('glob and grep return "cancelled" at once when the signal has already fired', async () => {
  const cwd = tree(500)
  const fired = AbortSignal.abort()
  const started = Date.now()
  const g = await ALL_TOOLS.find((t) => t.name === 'glob')!.run({ pattern: '**/*.txt' }, ctx(cwd, fired))
  const r = await ALL_TOOLS.find((t) => t.name === 'grep')!.run({ pattern: 'needle' }, ctx(cwd, fired))
  expect(g).toMatchObject({ isError: true, output: expect.stringMatching(/Cancelled/) })
  expect(r).toMatchObject({ isError: true, output: expect.stringMatching(/Cancelled/) })
  expect(Date.now() - started).toBeLessThan(200)
})

test('the JS search stops reading files once cancelled', async () => {
  const cwd = tree(1500) // every file matches, so a full run stops at the 200-match cap
  expect((await grepJs('needle', { root: cwd })).length).toBe(200)
  const controller = new AbortController()
  const search = grepJs('needle', { root: cwd, signal: controller.signal })
  controller.abort()
  expect((await search).length).toBeLessThan(200)
})

test('collectUntilAbort gives up on an iterator that is stuck, and still asks it to stop', async () => {
  let returned = false
  const stuck: AsyncIterable<number> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<number>>(() => {}), // never answers
      return: async () => {
        returned = true
        return { done: true, value: undefined }
      },
    }),
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 30)
  const items: number[] = []
  expect(await collectUntilAbort(stuck, controller.signal, (n) => items.push(n))).toBe(false)
  expect(returned).toBe(true)
  const done = await collectUntilAbort((async function* () { yield 1; yield 2 })(), new AbortController().signal, (n) => items.push(n))
  expect(done).toBe(true)
  expect(items).toEqual([1, 2])
})
