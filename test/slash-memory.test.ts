import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import type { ChatRequest, Provider } from '../src/provider'
import { Session } from '../src/session'
import { createRuntime } from '../src/setup'
import { appendMemory, instructionFiles } from '../src/slash/memory'

test('appendMemory creates AGENTS.md and instructionFiles lists it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bm-c-'))
  const home = mkdtempSync(join(tmpdir(), 'bm-h-'))
  appendMemory(join(cwd, 'AGENTS.md'), 'pakai pnpm')
  appendMemory(join(cwd, 'AGENTS.md'), 'jangan pakai var')
  expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe('- pakai pnpm\n- jangan pakai var\n')
  expect(instructionFiles(cwd, home)).toContainEqual({ path: join(cwd, 'AGENTS.md'), lines: 2 })
})

test('rebuildSystemPrompt makes new memory visible on the next turn; newSession starts a new file', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bm-r-'))
  const requests: ChatRequest[] = []
  const provider: Provider = {
    async chat(req) {
      requests.push(req)
      return { text: 'ok', toolCalls: [] }
    },
    async listModels() {
      return []
    },
  }
  const rt = createRuntime({
    cwd,
    args: parseCliArgs([]),
    env: { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bm-rh-')), BOTCONNECTOR_API_KEY: 'k' },
    provider,
    userHome: mkdtempSync(join(tmpdir(), 'bm-u-')),
  })
  await rt.agent.run('satu', new AbortController().signal)
  appendMemory(join(cwd, 'AGENTS.md'), 'selalu jawab singkat')
  rt.rebuildSystemPrompt()
  await rt.agent.run('dua', new AbortController().signal)
  expect(String(requests.at(-1)?.messages[0].content)).toContain('selalu jawab singkat')
  const before = rt.session.file
  rt.newSession()
  expect(rt.session.file).not.toBe(before)
  expect(rt.agent.messages).toEqual([])
  await rt.agent.run('tiga', new AbortController().signal)
  expect(rt.session.load().map((m) => m.content)).toEqual(['tiga', 'ok'])
})

test('/new creates no file until something is said; resume forgets files read in the other conversation', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bm-n-'))
  writeFileSync(join(cwd, 'a.txt'), 'old\n')
  const steps = [
    { text: '', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] },
    { text: 'dibaca', toolCalls: [] },
    { text: '', toolCalls: [{ id: '2', name: 'edit', arguments: '{"path":"a.txt","old_string":"old","new_string":"new"}' }] },
    { text: 'selesai', toolCalls: [] },
  ]
  const provider: Provider = {
    async chat() {
      return steps.shift() as never
    },
    async listModels() {
      return []
    },
  }
  const home = mkdtempSync(join(tmpdir(), 'bm-nh-'))
  const rt = createRuntime({ cwd, args: parseCliArgs(['--allow-all']), env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' }, provider, userHome: mkdtempSync(join(tmpdir(), 'bm-nu-')) })
  await rt.agent.run('baca a.txt', new AbortController().signal)
  const first = rt.session
  rt.newSession()
  expect(existsSync(rt.session.file)).toBe(false)
  expect(Session.latest(home, cwd)?.file).toBe(first.file)
  rt.resume(first)
  await rt.agent.run('ganti', new AbortController().signal)
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('old\n')
})
