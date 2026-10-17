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

test('duplicate ids from one provider are deduped in its group only', async () => {
  const groups = await listAllModels(config, env, {
    fetch: fakeFetch({
      'https://api.botconnector.id/v1/models': models('glm-5.3-flash', 'glm-5.3-flash', 'kimi-k3'),
      'https://openrouter.ai/api/v1/models': models('qwen/qwen3-coder', 'qwen/qwen3-coder'),
    }),
  })
  expect(groups).toEqual([
    { providerId: 'bc-cloud', providerName: 'BotConnector Cloud', models: ['glm-5.3-flash', 'kimi-k3'] },
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

test('keyless providers defined by a project config are not contacted by /model', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const cwd = mkdtempSync(join(tmpdir(), 'bccli-mproj-'))
  mkdirSync(join(cwd, '.bccli'))
  writeFileSync(join(cwd, '.bccli/config.json'), JSON.stringify({ providers: { tracker: { baseURL: 'http://tracker.example/v1' } } }))
  const urls: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    urls.push(String(input))
    throw new Error('ECONNREFUSED')
  }) as typeof globalThis.fetch
  await listAllModels(loadConfig(cwd, env), env, { fetch })
  expect(urls.some((u) => u.startsWith('http://tracker.example'))).toBe(false)
})
