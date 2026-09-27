import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { McpManager, mcpToolName } from '../src/mcp/manager'
import { toolDefinitions } from '../src/tools/index'

const fixture = join(__dirname, 'fixtures', 'echo-server.mjs')
const ctx = { cwd: '.', signal: new AbortController().signal, readFiles: new Set<string>() }
let manager: McpManager | undefined
afterEach(async () => manager?.stop())

test('connects a stdio server and exposes its tools with sanitized unique names', async () => {
  manager = new McpManager()
  await manager.start([{ name: 'echo', source: 'global', config: { command: process.execPath, args: [fixture] } }])
  expect(manager.states()).toEqual([{ name: 'echo', source: 'global', status: 'ready', tools: 3 }])
  const names = manager.tools().map((t) => t.name)
  expect(names).toEqual(['mcp__echo__echo', 'mcp__echo__fail', 'mcp__echo__weird_name_with_spaces'])
  const echo = manager.tools()[0]
  expect(echo.kind).toBe('mcp')
  expect(toolDefinitions([echo])[0].function.parameters).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } })
  expect((await echo.run({ text: 'hi' }, ctx)).output).toBe('echo: hi')
  const fail = await manager.tools()[1].run({}, ctx)
  expect(fail).toMatchObject({ output: 'boom', isError: true })
})

test('a server that cannot start is an error state and does not throw', async () => {
  manager = new McpManager()
  await manager.start([{ name: 'bad', source: 'global', config: { command: 'definitely-not-a-command-bccli' } }])
  expect(manager.states()[0]).toMatchObject({ name: 'bad', status: 'error' })
  expect(manager.tools()).toEqual([])
})

test('a server that never answers times out', async () => {
  manager = new McpManager({ connectTimeoutMs: 500 })
  const started = Date.now()
  await manager.start([{ name: 'hang', source: 'global', config: { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } }])
  expect(Date.now() - started).toBeLessThan(5000)
  expect(manager.states()[0]).toMatchObject({ status: 'error', error: expect.stringMatching(/timeout/) })
})

test('remove stops a server and drops its tools', async () => {
  manager = new McpManager()
  await manager.start([{ name: 'echo', source: 'global', config: { command: process.execPath, args: [fixture] } }])
  await manager.remove('echo')
  expect(manager.tools()).toEqual([])
  expect(manager.states()).toEqual([])
})

test('mcpToolName keeps names valid, short and unique', () => {
  const taken = new Set<string>()
  const a = mcpToolName('my.server', 'x'.repeat(100), taken)
  const b = mcpToolName('my.server', 'x'.repeat(100), taken)
  expect(a).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  expect(b).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  expect(a).not.toBe(b)
})
