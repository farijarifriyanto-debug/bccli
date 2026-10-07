import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
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
const env = () => ({ BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-ph-')), BOTCONNECTOR_API_KEY: 'k' })

test('prints the answer to stdout and tool lines to stderr', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-p-'))
  writeFileSync(join(cwd, 'a.txt'), 'x')
  const rt = createRuntime({
    cwd,
    args: parseCliArgs(['-p', 'go']),
    env: env(),
    provider: provider([{ text: '', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] }, { text: 'selesai', toolCalls: [] }]),
  })
  const o = io()
  expect(await runPrint(rt, 'go', o.io)).toBe(0)
  expect(o.out.join('')).toBe('selesai\n')
  expect(o.err.join('')).toContain('⎿ Read  a.txt')
})

test('print mode denies tools needing permission and says how to allow them', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-p-'))
  const rt = createRuntime({
    cwd,
    args: parseCliArgs(['-p', 'go']),
    env: env(),
    provider: provider([{ text: '', toolCalls: [{ id: '1', name: 'bash', arguments: '{"command":"ls"}' }] }, { text: 'ok', toolCalls: [] }]),
  })
  const o = io()
  await runPrint(rt, 'go', o.io)
  expect(o.err.join('')).toContain('--allow-all')
})

test('--allowed-tools bash lets bash run in print mode', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-p-'))
  const rt = createRuntime({
    cwd,
    args: parseCliArgs(['-p', 'go', '--allowed-tools', 'bash']),
    env: env(),
    provider: provider([{ text: '', toolCalls: [{ id: '1', name: 'bash', arguments: '{"command":"node -e \\"console.log(42)\\""}' }] }, { text: 'ok', toolCalls: [] }]),
  })
  const o = io()
  await runPrint(rt, 'go', o.io)
  expect(o.err.join('')).not.toContain('--allow-all')
  expect(rt.agent.messages.find((m) => m.role === 'tool')).toMatchObject({ content: expect.stringContaining('42') })
})

test('errors exit with code 1', async () => {
  const rt = createRuntime({ cwd: mkdtempSync(join(tmpdir(), 'bccli-p-')), args: parseCliArgs(['-p', 'go']), env: env(), provider: provider([]) })
  const o = io()
  expect(await runPrint(rt, 'go', o.io)).toBe(1)
})

test('missing API key surfaces as a ConfigError from createRuntime', () => {
  expect(() =>
    createRuntime({ cwd: tmpdir(), args: parseCliArgs(['-p', 'go']), env: { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-nk-')) } }),
  ).toThrow(/bccli login/)
})

test('--output-format selects a machine-readable format and validates values', () => {
  expect(parseCliArgs(['-p', 'go', '--output-format', 'json']).outputFormat).toBe('json')
  expect(parseCliArgs(['-p', 'go', '--output-format', 'stream-json']).outputFormat).toBe('stream-json')
  expect(parseCliArgs(['-p', 'go']).outputFormat).toBeUndefined()
  expect(() => parseCliArgs(['-p', 'go', '--output-format', 'xml'])).toThrow(/--output-format/)
})

test('json mode writes a single JSON object with status, model, and result to stdout', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-pj-'))
  writeFileSync(join(cwd, 'a.txt'), 'x')
  const rt = createRuntime({
    cwd,
    args: parseCliArgs(['-p', 'go']),
    env: env(),
    provider: provider([{ text: '', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] }, { text: 'selesai', toolCalls: [] }]),
  })
  const o = io()
  expect(await runPrint(rt, 'go', o.io, { outputFormat: 'json' })).toBe(0)
  const parsed = JSON.parse(o.out.join(''))
  expect(parsed).toMatchObject({ status: 'ok', model: rt.modelRef, result: 'selesai' })
  expect(o.err.join('')).toContain('⎿ Read')
})

test('json mode reports a failed run as status failed', async () => {
  const rt = createRuntime({ cwd: mkdtempSync(join(tmpdir(), 'bccli-pjf-')), args: parseCliArgs(['-p', 'go']), env: env(), provider: provider([]) })
  const o = io()
  expect(await runPrint(rt, 'go', o.io, { outputFormat: 'json' })).toBe(1)
  const parsed = JSON.parse(o.out.join(''))
  expect(parsed.status).toBe('failed')
})

test('stream-json mode writes JSONL events to stdout', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-ps-'))
  writeFileSync(join(cwd, 'a.txt'), 'x')
  const rt = createRuntime({
    cwd,
    args: parseCliArgs(['-p', 'go']),
    env: env(),
    provider: provider([{ text: '', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] }, { text: 'selesai', toolCalls: [] }]),
  })
  const o = io()
  expect(await runPrint(rt, 'go', o.io, { outputFormat: 'stream-json' })).toBe(0)
  const events = o.out
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(events.find((e) => e.type === 'tool_use')).toMatchObject({ tool: 'read', target: 'a.txt' })
  expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'read', isError: false })
  expect(events.find((e) => e.type === 'message')?.text).toContain('selesai')
  expect(events.at(-1)).toMatchObject({ type: 'result', status: 'ok', model: rt.modelRef })
  expect(o.err.join('')).toContain('⎿ Read')
})

test('resume switches the session file so new messages extend the resumed history', async () => {
  const e = env()
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-r-'))
  const first = createRuntime({ cwd, args: parseCliArgs(['-p', 'a']), env: e, provider: provider([{ text: 'satu', toolCalls: [] }]) })
  await runPrint(first, 'pertama', io().io)
  const second = createRuntime({ cwd, args: parseCliArgs([]), env: e, provider: provider([{ text: 'dua', toolCalls: [] }]) })
  second.resume(first.session)
  await runPrint(second, 'kedua', io().io)
  expect(second.session.file).toBe(first.session.file)
  expect(first.session.load().map((m) => m.content)).toEqual(['pertama', 'satu', 'kedua', 'dua'])
})
