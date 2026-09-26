import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../../src/args'
import type { Completion, Provider } from '../../src/provider'
import { createRuntime } from '../../src/setup'
import { App } from '../../src/ui/App'

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, timeoutMs = 3000) {
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
      return ['glm-5.3-flash', 'kimi-k3']
    },
  }
}

function makeRuntime(steps: Completion[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-app-'))
  writeFileSync(join(cwd, 'a.txt'), 'old\n')
  const env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-apph-')), BOTCONNECTOR_API_KEY: 'k' }
  return createRuntime({ cwd, args: parseCliArgs([]), env, provider: scripted(steps) })
}

test('full turn: read, edit with permission prompt, final answer', async () => {
  const rt = makeRuntime([
    { text: '', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] },
    { text: '', toolCalls: [{ id: '2', name: 'edit', arguments: '{"path":"a.txt","old_string":"old","new_string":"new"}' }] },
    { text: 'Sudah diganti.', toolCalls: [] },
  ])
  const { stdin, lastFrame, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  expect(lastFrame()).toContain('BCCLI test')
  stdin.write('ganti old jadi new')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('Izinkan edit a.txt?')))
  expect(frames.join('\n')).toContain('Izinkan edit a.txt?')
  expect(frames.join('\n')).toContain('+ new')
  await wait() // let the prompt subscribe to input before answering
  stdin.write('y')
  await waitFor(() => frames.some((f) => f.includes('Sudah diganti.')))
  const all = frames.join('\n')
  expect(all).toContain('⎿ Read  a.txt')
  expect(all).toContain('Sudah diganti.')
})

test('shift+tab cycles the permission mode', async () => {
  const rt = makeRuntime([])
  const { stdin, lastFrame } = render(<App runtime={rt} version="test" />)
  await wait()
  expect(lastFrame()).toContain('⏵ default')
  stdin.write('\u001B[Z')
  await wait()
  expect(lastFrame()).toContain('accept edits')
  expect(rt.agent.permissions.mode).toBe('acceptEdits')
})

test('/cost and unknown commands print notices; /clear resets history', async () => {
  const rt = makeRuntime([])
  rt.agent.messages.push({ role: 'user', content: 'x' })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  for (const cmd of ['/cost', '/nope', '/clear']) {
    stdin.write(cmd)
    await wait()
    stdin.write('\r')
    await wait()
  }
  const all = frames.join('\n')
  expect(all).toMatch(/token masuk/)
  expect(all).toContain('Perintah tidak dikenal: /nope')
  expect(rt.agent.messages).toEqual([])
})

test('whitespace-only assistant text before a tool call is not rendered as an empty bubble', async () => {
  const rt = makeRuntime([
    { text: '\n\n', toolCalls: [{ id: '1', name: 'read', arguments: '{"path":"a.txt"}' }] },
    { text: 'ok', toolCalls: [] },
  ])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('baca')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('● ok')))
  expect(frames.join('\n')).not.toMatch(/● *\n/)
})

test('Esc cancels a running /compact', async () => {
  const rt = makeRuntime([])
  rt.agent.provider = {
    chat: (req) =>
      new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    async listModels() {
      return []
    },
  }
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/compact')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('Berpikir')))
  stdin.write('\u001B')
  await waitFor(() => frames.some((f) => f.includes('Gagal meringkas')))
  expect(frames.join('\n')).toContain('Gagal meringkas')
})
