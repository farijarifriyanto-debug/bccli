import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import { readMcpFile } from '../src/mcp/config'
import { runMcpCommand } from '../src/mcpCli'

function deps(secret = '') {
  const lines: string[] = []
  const errors: string[] = []
  const home = mkdtempSync(join(tmpdir(), 'bm-'))
  return {
    env: { BCCLI_HOME: home },
    cwd: mkdtempSync(join(tmpdir(), 'bmc-')),
    out: (s: string) => lines.push(s),
    err: (s: string) => errors.push(s),
    readSecret: async () => secret,
    lines,
    errors,
    home,
  }
}
const run = (argv: string[], d: ReturnType<typeof deps>) => runMcpCommand(parseCliArgs(['mcp', ...argv]), d)

test('list shows the catalog with install status', async () => {
  const d = deps()
  await run(['add', 'context7'], d)
  expect(await run(['list'], d)).toBe(0)
  const text = d.lines.join('\n')
  expect(text).toMatch(/✓ context7/)
  expect(text).toMatch(/○ playwright/)
})

test('add from catalog with --value, prompting secrets; missing inputs fail', async () => {
  const d = deps('ghp_x')
  expect(await run(['add', 'filesystem'], d)).toBe(1)
  expect(await run(['add', 'filesystem', '--value', 'dir=/data'], d)).toBe(0)
  expect(await run(['add', 'github'], d)).toBe(0)
  expect(readMcpFile(join(d.home, 'mcp.json'))).toMatchObject({
    filesystem: { args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'] },
    github: { headers: { Authorization: 'Bearer ghp_x' } },
  })
})

test('add --url for any remote server; remove', async () => {
  const d = deps()
  expect(await run(['add', 'mine', '--url', 'https://mcp.example.com/mcp'], d)).toBe(0)
  expect(readMcpFile(join(d.home, 'mcp.json')).mine).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp' })
  expect(await run(['remove', 'mine'], d)).toBe(0)
  expect(readMcpFile(join(d.home, 'mcp.json')).mine).toBeUndefined()
})

test('auth and logout dispatch with usage errors for missing or non-http servers', async () => {
  const d = deps()
  expect(await run(['auth'], d)).toBe(1)
  expect(d.errors.join('\n')).toContain('auth')
  expect(await run(['auth', 'context7'], d)).toBe(1)
  expect(d.errors.join('\n')).toContain('context7')
  await run(['add', 'context7'], d)
  expect(await run(['logout', 'context7'], d)).toBe(0)
  expect(d.lines.join('\n')).toMatch(/context7.*OAuth/)
  await run(['add', 'filesystem', '--value', 'dir=/data'], d)
  expect(await run(['auth', 'filesystem'], d)).toBe(1)
  expect(d.errors.join('\n')).toContain('filesystem')
  expect(await run(['logout', 'filesystem'], d)).toBe(1)
  expect(d.errors.join('\n')).toContain('filesystem')
})

test('unknown mcp action mentions auth and logout', async () => {
  const d = deps()
  expect(await run(['frobnicate', 'x'], d)).toBe(1)
  expect(d.errors.join('\n')).toContain('auth')
  expect(d.errors.join('\n')).toContain('logout')
})

test('serve fails fast without an API key', async () => {
  const d = deps()
  expect(await run(['serve'], d)).toBe(1)
  expect(d.errors.join('\n')).toContain('bccli login bc-cloud')
})

test('unknown action mentions serve', async () => {
  const d = deps()
  expect(await run(['bogus', 'x'], d)).toBe(1)
  expect(d.errors.join('\n')).toContain('serve')
})
