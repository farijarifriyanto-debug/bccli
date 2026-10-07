import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, expect, test, vi } from 'vitest'
import { loadConfig } from '../../src/config'
import { listAllModels } from '../../src/models'
import { ModelPicker } from '../../src/ui/ModelPicker'

const env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-mp-')), BOTCONNECTOR_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }
const config = loadConfig(mkdtempSync(join(tmpdir(), 'bccli-mpc-')), env)

function fakeFetch(routes: Record<string, () => Promise<Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!hit) throw new Error(`ECONNREFUSED ${url}`)
    return routes[hit]()
  }) as typeof fetch
}
const models = (...ids: string[]) => async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }))

afterEach(() => {
  vi.restoreAllMocks()
})

test('duplicate upstream model ids do not produce duplicate rows or duplicate React keys', async () => {
  const groups = await listAllModels(config, env, {
    fetch: fakeFetch({
      'https://api.botconnector.id/v1/models': models('glm-5.3-flash', 'glm-5.3-flash', 'kimi-k3'),
      'https://openrouter.ai/api/v1/models': models('qwen/qwen3-coder', 'qwen/qwen3-coder'),
    }),
  })
  const errSpy = vi.spyOn(console, 'error')
  const warnSpy = vi.spyOn(console, 'warn')
  const { frames } = render(<ModelPicker groups={groups} current="" onPick={() => {}} />)
  const frame = frames.at(-1) ?? ''
  const count = (needle: string) => frame.split(needle).length - 1
  expect(count('glm-5.3-flash')).toBe(1)
  expect(count('kimi-k3')).toBe(1)
  expect(count('qwen/qwen3-coder')).toBe(1)
  const warnings = [...errSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n')
  expect(warnings).not.toContain('same key')
})
