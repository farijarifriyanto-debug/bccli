import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import { createRuntime } from '../src/setup'
import { SLASH_COMMANDS } from '../src/commands'
import type { Completion, Provider } from '../src/provider'

function provider(steps: Completion[]): Provider {
  return {
    async chat(req) {
      const next = steps.shift()
      if (!next) throw new Error('no more fake steps')
      if (next.text) req.onText?.(next.text)
      return next
    },
    async listModels() {
      return []
    },
  }
}

const writeStep = (id: string, path: string, content: string): Completion => ({
  text: '',
  toolCalls: [{ id, name: 'write', arguments: JSON.stringify({ path, content }) }],
})
const answer = (text: string): Completion => ({ text, toolCalls: [] })

function makeRuntime(cwd: string, steps: Completion[]) {
  const home = mkdtempSync(join(tmpdir(), 'bccli-rw-home-'))
  return createRuntime({
    cwd,
    args: parseCliArgs(['-p', 'x', '--allow-all']),
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' },
    provider: provider(steps),
  })
}

test('rewind drops the last turn: its files are reverted and the conversation loses it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-rw-'))
  const rt = makeRuntime(cwd, [writeStep('1', 'a.txt', 'v1'), answer('made a'), writeStep('2', 'b.txt', 'v2'), answer('made b')])
  await rt.agent.run('create a', new AbortController().signal)
  await rt.agent.run('create b', new AbortController().signal)
  expect(existsSync(join(cwd, 'a.txt'))).toBe(true)
  expect(existsSync(join(cwd, 'b.txt'))).toBe(true)

  const result = await rt.rewindTurns(1)
  expect(result?.turns).toBe(1)
  expect(existsSync(join(cwd, 'b.txt'))).toBe(false)
  expect(existsSync(join(cwd, 'a.txt'))).toBe(true)
  expect(rt.agent.messages.some((m) => m.role === 'user' && m.content === 'create b')).toBe(false)
  expect(rt.agent.messages.some((m) => m.role === 'user' && m.content === 'create a')).toBe(true)
  expect(rt.session.load()).toEqual(rt.agent.messages)
})

test('rewinding every turn empties the conversation and files; then there is nothing left', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-rw2-'))
  const rt = makeRuntime(cwd, [writeStep('1', 'a.txt', 'v1'), answer('made a')])
  await rt.agent.run('create a', new AbortController().signal)
  const first = await rt.rewindTurns(1)
  expect(first?.turns).toBe(1)
  expect(existsSync(join(cwd, 'a.txt'))).toBe(false)
  expect(rt.agent.messages).toEqual([])
  expect(await rt.rewindTurns(1)).toBeUndefined()
})

test('rewind 2 turns at once reverts both', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-rw3-'))
  const rt = makeRuntime(cwd, [writeStep('1', 'a.txt', 'v1'), answer('made a'), writeStep('2', 'b.txt', 'v2'), answer('made b')])
  await rt.agent.run('create a', new AbortController().signal)
  await rt.agent.run('create b', new AbortController().signal)
  const result = await rt.rewindTurns(2)
  expect(result?.turns).toBe(2)
  expect(existsSync(join(cwd, 'a.txt'))).toBe(false)
  expect(existsSync(join(cwd, 'b.txt'))).toBe(false)
  expect(rt.agent.messages).toEqual([])
})

test('a turn without file edits does not revert the edits of earlier turns', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-rw4-'))
  const rt = makeRuntime(cwd, [writeStep('1', 'a.txt', 'v1'), answer('made a'), answer('just talking')])
  await rt.agent.run('create a', new AbortController().signal)
  await rt.agent.run('hello', new AbortController().signal)
  const first = await rt.rewindTurns(1)
  expect(first?.turns).toBe(1)
  expect(existsSync(join(cwd, 'a.txt'))).toBe(true)
  expect(rt.agent.messages.some((m) => m.role === 'user' && m.content === 'hello')).toBe(false)
  const second = await rt.rewindTurns(1)
  expect(second?.turns).toBe(1)
  expect(existsSync(join(cwd, 'a.txt'))).toBe(false)
})

test('/rewind slash command is registered', () => {
  expect(SLASH_COMMANDS.some((c) => c.name === 'rewind')).toBe(true)
})
