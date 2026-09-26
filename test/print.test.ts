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
