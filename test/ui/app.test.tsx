import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../../src/args'
import type { Completion, Provider } from '../../src/provider'
import { createRuntime } from '../../src/setup'
import { readMcpFile } from '../../src/mcp/config'
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

function makeRuntime(steps: Completion[], setupExt?: (cwd: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-app-'))
  writeFileSync(join(cwd, 'a.txt'), 'old\n')
  setupExt?.(cwd)
  const env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-apph-')), BOTCONNECTOR_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }
  return createRuntime({ cwd, args: parseCliArgs([]), env, provider: scripted(steps), userHome: mkdtempSync(join(tmpdir(), 'bccli-appu-')) })
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

test('/model lists every provider and persists the choice as default', async () => {
  const rt = makeRuntime([])
  rt.listModels = async () => [
    { providerId: 'bc-cloud', providerName: 'BotConnector Cloud', models: ['glm-5.3-flash'] },
    { providerId: 'openrouter', providerName: 'OpenRouter', models: ['qwen/qwen3-coder'] },
  ]
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/model')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('OpenRouter')))
  await wait()
  stdin.write('qwen')
  await wait()
  stdin.write('\r')
  await waitFor(() => rt.modelRef === 'openrouter/qwen/qwen3-coder')
  expect(rt.modelRef).toBe('openrouter/qwen/qwen3-coder')
  expect(JSON.parse(readFileSync(join(rt.home, 'config.json'), 'utf8')).model).toBe('openrouter/qwen/qwen3-coder')
})

test('custom commands expand and run; built-ins win over same-named commands', async () => {
  const rt = makeRuntime([{ text: 'reviewed', toolCalls: [] }], (cwd) => {
    mkdirSync(join(cwd, '.bccli/commands'), { recursive: true })
    writeFileSync(join(cwd, '.bccli/commands/review.md'), '---\ndescription: review\n---\nPlease review $ARGUMENTS')
    writeFileSync(join(cwd, '.bccli/commands/help.md'), 'SHADOW')
  })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/rev')
  await wait()
  expect(frames.at(-1)).toContain('/review')
  stdin.write('iew src/a.ts')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('reviewed')))
  expect(rt.agent.messages[0]).toEqual({ role: 'user', content: 'Please review src/a.ts' })
  stdin.write('/help')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('Perintah custom')))
  expect(frames.join('\n')).not.toContain('SHADOW')
})

test('/mcp installs a catalog server and its tools reach the agent', async () => {
  const rt = makeRuntime([])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/mcp')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('context7')))
  await wait()
  stdin.write('\u001B[B')
  await wait()
  stdin.write('\r')
  await waitFor(() => rt.mcp.states().some((s) => s.name === 'context7'), 20000)
  expect(readMcpFile(join(rt.home, 'mcp.json')).context7).toEqual({ type: 'http', url: 'https://mcp.context7.com/mcp' })
  await rt.mcp.stop()
}, 30000)

test('two permission asks at once are queued, not lost', async () => {
  const rt = makeRuntime([])
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  const first = rt.agent.askPermission({ tool: 'bash', kind: 'bash', target: 'echo one', sessionRules: ['bash(echo)'] })
  const second = rt.agent.askPermission({ tool: 'bash', kind: 'bash', target: 'echo two', sessionRules: ['bash(echo)'] })
  await waitFor(() => frames.some((f) => f.includes('echo one')))
  await wait()
  stdin.write('y')
  await waitFor(() => frames.some((f) => f.includes('echo two')))
  await wait()
  stdin.write('n')
  expect(await first).toBe('yes')
  expect(await second).toBe('no')
})
