import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import { loadPlugins } from '../src/plugins'
import { createRuntime } from '../src/setup'
import type { Config } from '../src/config'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => join(here, 'fixtures', 'plugins', name)

const baseConfig = { plugins: [] } as unknown as Config

function loadOpts(overrides: Partial<Parameters<typeof loadPlugins>[1]> = {}) {
  return {
    home: mkdtempSync(join(tmpdir(), 'bccli-plugin-home-')),
    cwd: mkdtempSync(join(tmpdir(), 'bccli-plugin-cwd-')),
    env: { BCCLI_HOME: 'x' },
    config: baseConfig,
    builtinNames: ['bash', 'read', 'edit', 'task'],
    ...overrides,
  }
}

test('loadPlugins loads a plugin tool with normalized defaults', async () => {
  const { tools } = loadPlugins([fixture('tool-plugin.mjs')], loadOpts())
  expect(tools).toHaveLength(1)
  const tool = tools[0]!
  expect(tool.name).toBe('greeter')
  expect(tool.description).toContain('test plugin')
  expect(tool.kind).toBe('read')
  expect(tool.target({})).toBe('greeter')
  await expect(tool.run({}, { cwd: '.', signal: new AbortController().signal, readFiles: new Set() })).resolves.toMatchObject({
    output: 'hello from plugin',
  })
  const ctx = (globalThis as { __pluginCtx?: { cwd: string; env: NodeJS.ProcessEnv; config: unknown } }).__pluginCtx
  expect(ctx?.cwd).toBeTruthy()
  expect(ctx?.env).toBeTruthy()
  expect(ctx?.config).toBe(baseConfig)
})

test('loadPlugins resolves ./ specs relative to the config home', () => {
  const opts = loadOpts()
  const spec = './plugins/tool-plugin.mjs'
  const target = join(opts.home, 'plugins', 'tool-plugin.mjs')
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(fixture('tool-plugin.mjs'), target)
  const { tools } = loadPlugins([spec], opts)
  expect(tools.map((t) => t.name)).toContain('greeter')
})

test('a missing plugin file fails fast with a clear error', () => {
  expect(() => loadPlugins([fixture('nope.mjs')], loadOpts())).toThrow(/nope\.mjs/)
})

test('a plugin with a syntax error fails fast naming the spec', () => {
  expect(() => loadPlugins([fixture('broken.mjs')], loadOpts())).toThrow(/broken\.mjs/)
})

test('an activation error fails fast with the plugin reason', () => {
  expect(() => loadPlugins([fixture('throws.mjs')], loadOpts())).toThrow(/activation boom/)
})

test('a tool name that collides with a built-in is rejected', () => {
  expect(() => loadPlugins([fixture('collide.mjs')], loadOpts())).toThrow(/bash/)
})

test('plugin event handlers run in order and one failure does not stop the rest', async () => {
  const order: string[] = []
  ;(globalThis as { __pluginOrder?: string[] }).__pluginOrder = order
  const { emit } = loadPlugins([fixture('event-plugin.mjs')], loadOpts())
  await expect(emit('SessionStart', {})).resolves.toBeUndefined()
  expect((globalThis as { __pluginOrder?: string[] }).__pluginOrder).toEqual(['first', 'second', 'third'])
})

test('emit is a no-op when no plugin listened to the event', async () => {
  const { emit } = loadPlugins([], loadOpts())
  await expect(emit('Stop', {})).resolves.toBeUndefined()
})

test('createRuntime loads tools from the global config plugins list', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-plug-rt-home-'))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-plug-rt-cwd-'))
  const plugin = fixture('tool-plugin.mjs')
  mkdirSync(join(home), { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ plugins: [plugin] }), 'utf8')
  const rt = createRuntime({
    cwd,
    args: parseCliArgs([]),
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'test-key' },
    provider: {
      async chat() {
        return { text: 'ok', toolCalls: [] }
      },
      async listModels() {
        return []
      },
    },
  })
  expect(rt.agent.tools.map((t) => t.name)).toContain('greeter')
  await expect(rt.emitPlugins('Stop')).resolves.toBeUndefined()
})
