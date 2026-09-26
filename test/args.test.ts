import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'

test('interactive with an initial prompt', () => {
  expect(parseCliArgs(['fix', 'the', 'bug'])).toMatchObject({ command: 'run', prompt: 'fix the bug', print: false })
})

test('print mode flags', () => {
  const a = parseCliArgs(['-p', 'do it', '-m', 'bc-cloud/x', '--allow-all', '--allowed-tools', 'bash,edit', '-c'])
  expect(a).toMatchObject({ print: true, prompt: 'do it', model: 'bc-cloud/x', allowAll: true, allowedTools: ['bash', 'edit'], continue: true })
})

test('subcommands', () => {
  expect(parseCliArgs(['login'])).toMatchObject({ command: 'login', loginProvider: 'bc-cloud' })
  expect(parseCliArgs(['login', 'openrouter']).loginProvider).toBe('openrouter')
  expect(parseCliArgs(['models']).command).toBe('models')
})

test('rejects unknown permission modes', () => {
  expect(() => parseCliArgs(['--permission-mode', 'yolo'])).toThrow(/default, acceptEdits, plan, allowAll/)
})
