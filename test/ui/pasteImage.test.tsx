import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { beforeEach, expect, test, vi } from 'vitest'
import { parseCliArgs } from '../../src/args'
import type { Completion, Provider } from '../../src/provider'
import { createRuntime } from '../../src/setup'
import { App } from '../../src/ui/App'

const grab = vi.fn()
vi.mock('../../src/clipboardImage', () => ({
  grabClipboardImage: (...args: unknown[]) => grab(...args),
}))

const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, timeoutMs = 10000) {
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

beforeEach(() => {
  grab.mockReset()
})

function makeRuntime() {
  const home = mkdtempSync(join(tmpdir(), 'bccli-pi-h-'))
  writeFileSync(join(home, 'config.json'), '{}')
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-pi-c-'))
  return createRuntime({
    cwd,
    args: parseCliArgs([]),
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'k' },
    provider: scripted([]),
    userHome: mkdtempSync(join(tmpdir(), 'bccli-pi-u-')),
  })
}

test('alt+v grabs a clipboard image and inserts its path into the prompt', async () => {
  const fakePath = join(tmpdir(), 'bccli-clip-fake.png')
  grab.mockResolvedValue(fakePath)
  const rt = makeRuntime()
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('\x1bv') // alt+v
  await waitFor(() => frames.some((f) => f.includes('bccli-clip-fake.png')))
  const all = frames.join('\n')
  expect(grab).toHaveBeenCalledOnce()
  expect(all).toContain('bccli-clip-fake.png') // notice + prompt input
})

test('alt+v with an empty clipboard warns and inserts nothing', async () => {
  grab.mockResolvedValue(undefined)
  const rt = makeRuntime()
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('\x1bv')
  await waitFor(() => frames.some((f) => f.toLowerCase().includes('clipboard') || f.includes('gambar')))
  expect(frames.join('\n').toLowerCase()).not.toContain('bccli-clip')
})
