import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runHooks } from '../src/hooks'
import { parseCliArgs } from '../src/args'
import { runPrint } from '../src/print'
import type { Completion, Provider } from '../src/provider'
import { createRuntime } from '../src/setup'

function provider(steps: Completion[]): Provider {
  return {
    async chat(req) {
      const next = steps.shift()!
      if (next.text) req.onText?.(next.text)
      return next
    },
    async listModels() {
      return []
    },
  }
}
function io() {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: { write: (s: string) => out.push(s) }, err: { write: (s: string) => err.push(s) } } }
}
const writeScript = (dir: string, name: string, body: string) => {
  const path = join(dir, name)
  writeFileSync(path, body)
  return `node "${path}"`
}

test('PreToolUse exit 2 blocks the call with the hook message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bccli-hk1-'))
  const command = writeScript(dir, 'block.js', 'process.stderr.write("hooked by policy"); process.exit(2)')
  const out = await runHooks({ PreToolUse: [{ match: 'bash', command }] }, 'PreToolUse', { tool: 'bash', input: { command: 'ls' } })
  expect(out.blocked).toContain('hooked by policy')
})

test('a rule only fires for the tool names it matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bccli-hk2-'))
  const marker = join(dir, 'fired.txt')
  const command = writeScript(dir, 'fire.js', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(2)`)
  const hooks = { PreToolUse: [{ match: 'write', command }] }
  const out = await runHooks(hooks, 'PreToolUse', { tool: 'bash', input: {} })
  expect(out.blocked).toBeUndefined()
  expect(existsSync(marker)).toBe(false)
  const hit = await runHooks(hooks, 'PreToolUse', { tool: 'write', input: {} })
  expect(hit.blocked).toBeDefined()
  expect(existsSync(marker)).toBe(true)
})

test('the hook receives the event, tool, and input as environment variables', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bccli-hk3-'))
  const seen = join(dir, 'seen.txt')
  const command = writeScript(
    dir,
    'env.js',
    `require('fs').writeFileSync(process.env.HOOK_SEEN, [process.env.BCCLI_HOOK_EVENT, process.env.BCCLI_HOOK_TOOL, process.env.BCCLI_HOOK_INPUT].join('|'))`,
  )
  await runHooks({ PreToolUse: [{ command }] }, 'PreToolUse', { tool: 'read', input: { path: 'a.txt' } }, { env: { HOOK_SEEN: seen } })
  expect(readFileSync(seen, 'utf8')).toBe('PreToolUse|read|{"path":"a.txt"}')
})

test('a failing hook without exit 2 warns but does not block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bccli-hk4-'))
  const command = writeScript(dir, 'boom.js', 'process.exit(1)')
  const out = await runHooks({ PreToolUse: [{ command }] }, 'PreToolUse', { tool: 'bash', input: {} })
  expect(out.blocked).toBeUndefined()
  expect(out.warnings.length).toBeGreaterThan(0)
})

test('PostToolUse receives the tool output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bccli-hk5-'))
  const seen = join(dir, 'out.txt')
  const command = writeScript(dir, 'out.js', 'require("fs").writeFileSync(process.env.HOOK_SEEN, process.env.BCCLI_HOOK_OUTPUT)')
  await runHooks({ PostToolUse: [{ command }] }, 'PostToolUse', { tool: 'bash', input: {}, output: 'line1\nline2' }, { env: { HOOK_SEEN: seen } })
  expect(readFileSync(seen, 'utf8')).toBe('line1\nline2')
})

test('no hooks configured is a no-op', async () => {
  expect(await runHooks(undefined, 'PreToolUse', { tool: 'bash' })).toEqual({ blocked: undefined, warnings: [] })
  expect(await runHooks({}, 'SessionStart')).toEqual({ blocked: undefined, warnings: [] })
})

test('a blocking PreToolUse hook stops bash in print mode', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-hk6-'))
  const dir = mkdtempSync(join(tmpdir(), 'bccli-hk6d-'))
  const command = writeScript(dir, 'block.js', 'process.stderr.write("hooked by policy"); process.exit(2)')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ hooks: { PreToolUse: [{ match: 'bash', command }] } }))
  const rt = createRuntime({
    cwd: dir,
    args: parseCliArgs(['-p', 'go', '--allow-all']),
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' },
    provider: provider([{ text: '', toolCalls: [{ id: '1', name: 'bash', arguments: '{"command":"echo hi"}' }] }, { text: 'ok', toolCalls: [] }]),
  })
  const o = io()
  await runPrint(rt, 'go', o.io, { allowAll: true })
  expect(o.err.join('')).toContain('hooked by policy')
  expect(rt.agent.messages.find((m) => m.role === 'tool')?.content).toContain('hooked by policy')
  expect(rt.agent.messages.some((m) => m.role === 'tool' && String(m.content).includes('hi'))).toBe(false)
})

test('print mode runs SessionStart and Stop hooks around the run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-hk7-'))
  const dir = mkdtempSync(join(tmpdir(), 'bccli-hk7d-'))
  const log = join(dir, 'order.txt')
  const start = writeScript(dir, 'start.js', `require('fs').appendFileSync(${JSON.stringify(log)}, 'SessionStart\\n')`)
  const stop = writeScript(dir, 'stop.js', `require('fs').appendFileSync(${JSON.stringify(log)}, 'Stop\\n')`)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ hooks: { SessionStart: [{ command: start }], Stop: [{ command: stop }] } }))
  const rt = createRuntime({ cwd: dir, args: parseCliArgs(['-p', 'go']), env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' }, provider: provider([{ text: 'ok', toolCalls: [] }]) })
  await runPrint(rt, 'go', io().io)
  expect(readFileSync(log, 'utf8')).toBe('SessionStart\nStop\n')
})
