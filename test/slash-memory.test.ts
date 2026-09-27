import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import type { ChatRequest, Provider } from '../src/provider'
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
