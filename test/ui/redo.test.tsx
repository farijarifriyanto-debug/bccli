import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../../src/args'
import type { Completion, Provider } from '../../src/provider'
import { createRuntime } from '../../src/setup'
import { App } from '../../src/ui/App'

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs
  while (!check() && Date.now() < end) await wait(20)
}

function scripted(steps: Completion[]): Provider {
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

test('/redo re-applies what /undo just reverted, end to end in the UI', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-redo-'))
  const env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-redoh-')), BOTCONNECTOR_API_KEY: 'k' }
  const rt = createRuntime({
    cwd,
    args: parseCliArgs(['--allow-all']),
    env,
    provider: scripted([
      { text: '', toolCalls: [{ id: '1', name: 'write', arguments: '{"path":"a.txt","content":"NEW"}' }] },
      { text: 'SELESAI', toolCalls: [] },
    ]),
    userHome: mkdtempSync(join(tmpdir(), 'bccli-redou-')),
  })
  const file = join(cwd, 'a.txt')
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('buat file a.txt')
  await wait()
  stdin.write('\r')
  await waitFor(() => existsSync(file) && readFileSync(file, 'utf8') === 'NEW')
  expect(readFileSync(file, 'utf8')).toBe('NEW')

  stdin.write('/undo')
  await wait()
  stdin.write('\r')
  await waitFor(() => !existsSync(file))
  expect(existsSync(file)).toBe(false)

  stdin.write('/redo')
  await wait()
  stdin.write('\r')
  await waitFor(() => existsSync(file) && readFileSync(file, 'utf8') === 'NEW')
  expect(readFileSync(file, 'utf8')).toBe('NEW')
  expect(frames.join('\n')).not.toContain('Unknown command')
})

test('/redo without a preceding /undo says there is nothing to redo', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-redo2-'))
  const env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-redo2h-')), BOTCONNECTOR_API_KEY: 'k' }
  const rt = createRuntime({ cwd, args: parseCliArgs([]), env, provider: scripted([]), userHome: mkdtempSync(join(tmpdir(), 'bccli-redo2u-')) })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/redo')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.toLowerCase().includes('redo')))
  expect(frames.join('\n').toLowerCase()).not.toContain('unknown command')
})
