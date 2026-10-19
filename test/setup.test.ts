import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import type { ChatRequest, Provider } from '../src/provider'
import { createRuntime, lunaPtcAutoEnabled } from '../src/setup'

test('Luna PTC auto mode is enabled by default for normal users', () => {
  expect(lunaPtcAutoEnabled({})).toBe(true)
  expect(lunaPtcAutoEnabled({ BCCLI_LUNA_PTC: '1' })).toBe(true)
  expect(lunaPtcAutoEnabled({ BCCLI_LUNA_PTC: 'auto' })).toBe(true)
})

test('Luna PTC has an internal emergency kill switch', () => {
  for (const value of ['0', 'false', 'FALSE', 'off', 'no']) {
    expect(lunaPtcAutoEnabled({ BCCLI_LUNA_PTC: value })).toBe(false)
  }
})

test('switching model rebuilds the system prompt with the active runtime model', async () => {
  const requests: ChatRequest[] = []
  const provider: Provider = {
    async chat(req) {
      requests.push(req)
      return { text: 'ok', toolCalls: [] }
    },
    async listModels() {
      return []
    },
  }
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-setup-cwd-'))
  const home = mkdtempSync(join(tmpdir(), 'bccli-setup-home-'))
  const rt = createRuntime({
    cwd,
    args: parseCliArgs([]),
    env: { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'test-key' },
    provider,
  })

  rt.setModel('bc-cloud/mimo-v2.6-flash')
  await rt.agent.run('siapa model aktif?', new AbortController().signal)

  const system = String(requests.at(-1)?.messages[0]?.content)
  expect(system).toContain('- Model: bc-cloud/mimo-v2.6-flash')
  expect(system).not.toContain('- Model: bc-cloud/glm-5.3-flash')
})

test('resume restores the session totalUsage and lastModel when no CLI model override was given', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-setup-res-'))
  const home = mkdtempSync(join(tmpdir(), 'bccli-setup-resh-'))
  const env = { BCCLI_HOME: home, BOTCONNECTOR_API_KEY: 'test-key' }
  const first = createRuntime({ cwd, args: parseCliArgs([]), env })
  first.session.append({ role: 'user', content: 'halo' })
  first.session.appendUsage({ inputTokens: 120, outputTokens: 30, model: 'bc-cloud/gpt-oss-120b' })

  const second = createRuntime({ cwd, args: parseCliArgs([]), env })
  second.resume(first.session)
  expect(second.modelRef).toBe('bc-cloud/gpt-oss-120b')
  expect(first.session.totalUsage()).toMatchObject({ inputTokens: 120, outputTokens: 30 })

  second.setModel('bc-cloud/mimo-v2.6-flash')
  expect(second.agent.getBudgetModel()).toBe('bc-cloud/mimo-v2.6-flash')
  expect(second.agent.getContextWindow()).toBeGreaterThan(0)
})
