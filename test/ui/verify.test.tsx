import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../../src/args'
import type { Completion, Provider } from '../../src/provider'
import { createRuntime } from '../../src/setup'
import { App } from '../../src/ui/App'

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, timeoutMs = 20000) {
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

test('a turn that edits files triggers verifyCommands and feeds failures back to the model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-v1h-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ verifyCommands: ['node -e "process.exit(3)"'] }))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-v1c-'))
  const steps: Completion[] = [
    { text: '', toolCalls: [{ id: '1', name: 'write', arguments: '{"path":"a.txt","content":"NEW"}' }] },
    { text: 'FIXED_IT', toolCalls: [] },
  ]
  const rt = createRuntime({
    cwd,
    args: parseCliArgs(['--allow-all']),
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' },
    provider: scripted(steps),
    userHome: mkdtempSync(join(tmpdir(), 'bccli-v1u-')),
  })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('buat file a.txt')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('FIXED_IT')) && frames.some((f) => f.includes('process.exit(3)')))
  const all = frames.join('\n')
  expect(existsSync(join(cwd, 'a.txt'))).toBe(true)
  expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('NEW')
  expect(steps.length).toBe(0) // the verify follow-up reached the model
  expect(all).toContain('process.exit(3)') // the verify notice names the command
  expect(all.toLowerCase()).toContain('memverifikasi')
})

test('a turn without edits does not run verifyCommands', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bccli-v2h-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ verifyCommands: ['node -e "process.exit(3)"'] }))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-v2c-'))
  const steps: Completion[] = [{ text: 'HANYA_TEKS', toolCalls: [] }]
  const rt = createRuntime({
    cwd,
    args: parseCliArgs([]),
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' },
    provider: scripted(steps),
    userHome: mkdtempSync(join(tmpdir(), 'bccli-v2u-')),
  })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('halo')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('HANYA_TEKS')))
  await wait(500)
  expect(frames.join('\n').toLowerCase()).not.toContain('memverifikasi')
})
