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

test('parses reasoning and rejects invalid values', () => {
  expect(parseCliArgs(['-p', 'fix', '--reasoning', 'high']).reasoning).toBe('high')
  expect(() => parseCliArgs(['--reasoning', 'extreme'])).toThrow(/auto, off, low, medium, high, max/)
})

test('rejects unknown permission modes', () => {
  expect(() => parseCliArgs(['--permission-mode', 'yolo'])).toThrow(/default, acceptEdits, plan, allowAll/)
})

test('provider and mcp subcommands keep their sub-arguments', () => {
  expect(parseCliArgs(['provider', 'add', 'corp', '--url', 'https://c/v1', '--name', 'Corp', '--key-env', 'CORP_KEY'])).toMatchObject({
    command: 'provider',
    subArgs: ['add', 'corp'],
    url: 'https://c/v1',
    name: 'Corp',
    keyEnv: 'CORP_KEY',
  })
  expect(parseCliArgs(['mcp', 'add', 'filesystem', '--value', 'dir=/tmp', '--value', 'x=y'])).toMatchObject({
    command: 'mcp',
    subArgs: ['add', 'filesystem'],
    values: ['dir=/tmp', 'x=y'],
  })
})

test('the worktree flag takes an explicit name', () => {
  expect(parseCliArgs(['-w', 'feat-x']).worktree).toBe('feat-x')
  expect(parseCliArgs(['--worktree', 'feat-y']).worktree).toBe('feat-y')
  expect(parseCliArgs(['hello']).worktree).toBeUndefined()
})

test('serve: parsing subcommand + flags', () => {
  const a = parseCliArgs(['serve', '--port', '9001', '--token', 'tk', '--host', '127.0.0.1'])
  expect(a.command).toBe('serve')
  expect(a.port).toBe(9001)
  expect(a.token).toBe('tk')
  expect(a.host).toBe('127.0.0.1')
  expect(parseCliArgs(['serve']).port).toBeUndefined()
})

test('serve: host non-loopback ditolak fail-loud saat parse', () => {
  expect(() => parseCliArgs(['serve', '--host', '0.0.0.0'])).toThrow(/loopback/)
})

test('serve: port bukan angka / di luar rentang ditolak', () => {
  expect(() => parseCliArgs(['serve', '--port', 'abc'])).toThrow(/--port/)
  expect(() => parseCliArgs(['serve', '--port', '70000'])).toThrow(/--port/)
})
