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

function makeRuntime(globalConfig: object) {
  const homeDir = mkdtempSync(join(tmpdir(), 'bccli-kb-home-'))
  writeFileSync(join(homeDir, 'config.json'), JSON.stringify(globalConfig))
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-kb-cwd-'))
  const env = { BCCLI_HOME: homeDir, BOTCONNECTOR_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }
  return createRuntime({ cwd, args: parseCliArgs([]), env, provider: scripted([]), userHome: mkdtempSync(join(tmpdir(), 'bccli-kb-u-')) })
}

test('ctrl+t toggles the thinking display by default', async () => {
  const rt = makeRuntime({})
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('\x14') // ctrl+t
  await waitFor(() => frames.some((f) => f.includes('ctrl+t')))
  expect(frames.join('\n')).toContain('ctrl+t')
})

test('a rebound thinking key works and the old binding stops firing', async () => {
  const rt = makeRuntime({ keybinds: { thinking: 'alt+x' } })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('\x14') // ctrl+t: no longer bound to thinking
  await wait(200)
  expect(frames.join('\n')).not.toContain('ctrl+t')
  stdin.write('\x1bx') // alt+x
  await waitFor(() => frames.some((f) => f.includes('alt+x')))
  expect(frames.join('\n')).toContain('alt+x')
})

test('/help lists the configured bindings', async () => {
  const rt = makeRuntime({ keybinds: { thinking: 'alt+x' } })
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('/help')
  await wait()
  stdin.write('\r')
  await waitFor(() => frames.some((f) => f.includes('alt+x')))
  expect(frames.join('\n')).toContain('alt+x')
})
