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
  expect(echo.programmaticSafe).toBe(true)
  expect(manager.tools()[1].programmaticSafe).toBe(false)
  expect(toolDefinitions([echo])[0].function.parameters).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } })
  expect((await echo.run({ text: 'hi' }, ctx)).output).toBe('echo: hi')
  const huge = await echo.run({ text: 'x'.repeat(40_000) }, ctx)
  expect(huge.output.length).toBeLessThan(32_200)
  expect(huge.output).toContain('truncated at 32000 characters')
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

test('removing a server while it is still connecting closes its process', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const pidfile = join(mkdtempSync(join(tmpdir(), 'pid-')), 'pid')
  manager = new McpManager()
  const adding = manager.add({ name: 'echo', source: 'global', config: { command: process.execPath, args: [fixture], env: { PIDFILE: pidfile } } })
  for (let i = 0; i < 100 && !existsSync(pidfile); i++) await new Promise((r) => setTimeout(r, 20))
  await manager.remove('echo')
  await adding
  const pid = Number(readFileSync(pidfile, 'utf8'))
  await new Promise((r) => setTimeout(r, 300))
  expect(() => process.kill(pid, 0)).toThrow()
  expect(manager.states()).toEqual([])
})

test('removing a server reports its tool names so session grants can be revoked', async () => {
  const removed: string[] = []
  manager = new McpManager({ onToolsRemoved: (names) => removed.push(...names) })
  await manager.start([{ name: 'echo', source: 'global', config: { command: process.execPath, args: [fixture] } }])
  await manager.remove('echo')
  expect(removed).toEqual(['mcp__echo__echo', 'mcp__echo__fail', 'mcp__echo__weird_name_with_spaces'])
})
