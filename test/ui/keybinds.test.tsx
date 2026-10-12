import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

const thinkingEnabled = (home: string) =>
  (JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { thinkingVisible?: boolean }).thinkingVisible === true

test('ctrl+t toggles the persisted Thinking view without writing notices to scrollback', async () => {
  const rt = makeRuntime({})
  const { stdin, frames } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('\x14')
  await waitFor(() => thinkingEnabled(rt.env.BCCLI_HOME!))
  expect(thinkingEnabled(rt.env.BCCLI_HOME!)).toBe(true)
  stdin.write('\x14')
  await waitFor(() => !thinkingEnabled(rt.env.BCCLI_HOME!))
  expect(frames.join('\n')).not.toContain('Thinking shown')
  expect(frames.join('\n')).not.toContain('Thinking hidden')
})

test('a rebound Thinking key works and old binding does not change visibility', async () => {
  const rt = makeRuntime({ keybinds: { thinking: 'alt+x' } })
  const { stdin } = render(<App runtime={rt} version="test" />)
  await wait()
  stdin.write('\x14')
  await wait(150)
  expect(thinkingEnabled(rt.env.BCCLI_HOME!)).toBe(false)
  stdin.write('\x1bx')
  await waitFor(() => thinkingEnabled(rt.env.BCCLI_HOME!))
  expect(thinkingEnabled(rt.env.BCCLI_HOME!)).toBe(true)
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
