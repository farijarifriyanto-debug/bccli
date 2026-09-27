import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadConfig } from '../src/config'
import { listAllModels } from '../src/models'

const env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-m-')), BOTCONNECTOR_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }
const config = loadConfig(mkdtempSync(join(tmpdir(), 'bccli-mc-')), env)

function fakeFetch(routes: Record<string, () => Promise<Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!hit) throw new Error(`ECONNREFUSED ${url}`)
    return routes[hit]()
  }) as typeof fetch
}
const models = (...ids: string[]) => async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }))

test('groups models per provider with a key, BotConnector first, skips unreachable local ones', async () => {
  const groups = await listAllModels(config, env, {
    fetch: fakeFetch({
      'https://api.botconnector.id/v1/models': models('glm-5.3-flash', 'deepseek-v4-flash'),
      'https://openrouter.ai/api/v1/models': models('qwen/qwen3-coder'),
    }),
  })
  expect(groups).toEqual([
    { providerId: 'bc-cloud', providerName: 'BotConnector Cloud', models: ['deepseek-v4-flash', 'glm-5.3-flash'] },
    { providerId: 'openrouter', providerName: 'OpenRouter', models: ['qwen/qwen3-coder'] },
  ])
})

test('a slow or failing remote provider becomes an error group instead of blocking', async () => {
  const groups = await listAllModels(config, env, {
    timeoutMs: 100,
    fetch: fakeFetch({
      'https://api.botconnector.id/v1/models': models('glm'),
      'https://openrouter.ai/api/v1/models': () => new Promise(() => {}),
    }),
  })
  expect(groups[1]).toMatchObject({ providerId: 'openrouter', models: [], error: 'tidak bisa dihubungi' })
})

test('only= limits to one provider', async () => {
  const groups = await listAllModels(config, env, { only: 'openrouter', fetch: fakeFetch({ 'https://openrouter.ai': models('x') }) })
  expect(groups.map((g) => g.providerId)).toEqual(['openrouter'])
})
