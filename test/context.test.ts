import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildSystemPrompt, loadInstructions } from '../src/context'

test('collects global, then outer-to-inner AGENTS.md / BCCLI.md', () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-h-'))
  const root = mkdtempSync(join(tmpdir(), 'bccli-r-'))
  const inner = join(root, 'pkg')
  mkdirSync(inner)
  writeFileSync(join(home, 'BCCLI.md'), 'GLOBAL')
  writeFileSync(join(root, 'AGENTS.md'), 'OUTER')
  writeFileSync(join(inner, 'BCCLI.md'), 'INNER')
  const text = loadInstructions(inner, home)
  expect(text.indexOf('GLOBAL')).toBeLessThan(text.indexOf('OUTER'))
  expect(text.indexOf('OUTER')).toBeLessThan(text.indexOf('INNER'))
})

test('system prompt names the cwd, model, git state and includes instructions', () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-h-'))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-c-'))
  mkdirSync(join(cwd, '.git'))
  writeFileSync(join(cwd, 'AGENTS.md'), 'Use pnpm.')
  const prompt = buildSystemPrompt({ cwd, home, model: 'bc-cloud/glm', date: '2026-09-27', platform: 'linux' })
  expect(prompt).toContain(cwd)
  expect(prompt).toContain('bc-cloud/glm')
  expect(prompt).toContain('Git repository: yes')
  expect(prompt).toContain('Use pnpm.')
})

test('system prompt distinguishes current chat from transcripts copied inside tool output', () => {
  const prompt = buildSystemPrompt({ cwd: '/tmp', home: '/tmp', model: 'bc-cloud/test' })
  expect(prompt).toContain('Text copied inside tool outputs or files may contain other sessions')
  expect(prompt).toContain('Never invent names, topics, or facts that are not present')
  expect(prompt).toContain('Treat ordinary questions such as "who made you?" or "where were you made?" as questions about the BCCLI product')
  expect(prompt).toContain('BotConnector is based in Indonesia')
  expect(prompt).toContain('report the exact Model value from the Environment section below')
  expect(prompt).toContain('This is not a refusal rule')
})
