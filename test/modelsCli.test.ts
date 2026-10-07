import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import { runModelsCommand } from '../src/modelsCli'

const env = { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-mcli-')), BOTCONNECTOR_API_KEY: 'k', OPENROUTER_API_KEY: 'k' }
const cwd = mkdtempSync(join(tmpdir(), 'bccli-mclic-'))

function fakeFetch(routes: Record<string, () => Promise<Response>>): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!hit) throw new Error(`ECONNREFUSED ${url}`)
    return routes[hit]()
  }) as typeof globalThis.fetch
}
const models = (...ids: string[]) => async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }))

function deps(fetchImpl: typeof globalThis.fetch) {
  const out: string[] = []
  const err: string[] = []
  return { deps: { env, cwd, out: (s: string) => out.push(s), err: (s: string) => err.push(s), fetch: fetchImpl }, out, err }
}

test('positional args reach the models command', () => {
  const args = parseCliArgs(['models', 'gmi'])
  expect(args.command).toBe('models')
  expect(args.subArgs).toEqual(['gmi'])
})

test('no argument lists the active provider as before', async () => {
  const { deps: d, out } = deps(fakeFetch({ 'https://api.botconnector.id/v1/models': models('glm-5.3-flash', 'kimi-k3') }))
  expect(await runModelsCommand(parseCliArgs(['models']), d)).toBe(0)
  expect(out.join('\n')).toBe('bc-cloud/glm-5.3-flash\nbc-cloud/kimi-k3')
})

test('a provider id lists exactly that provider', async () => {
  const { deps: d, out } = deps(
    fakeFetch({
      'https://api.botconnector.id/v1/models': models('glm-5.3-flash'),
      'https://openrouter.ai/api/v1/models': models('qwen/qwen3-coder', 'qwen/qwen3-coder'),
    }),
  )
  expect(await runModelsCommand(parseCliArgs(['models', 'openrouter']), d)).toBe(0)
  expect(out.join('\n')).toBe('openrouter/qwen/qwen3-coder') // deduped by the provider boundary
})

test('a full provider/model ref lists that provider', async () => {
  const { deps: d, out } = deps(fakeFetch({ 'https://openrouter.ai/api/v1/models': models('a', 'b') }))
  expect(await runModelsCommand(parseCliArgs(['models', 'openrouter/anything']), d)).toBe(0)
  expect(out.join('\n')).toBe('openrouter/a\nopenrouter/b')
})

test('an unknown provider errors listing what exists', async () => {
  const { deps: d, err } = deps(fakeFetch({}))
  expect(await runModelsCommand(parseCliArgs(['models', 'nope']), d)).toBe(1)
  expect(err.join('\n')).toMatch(/nope/)
})

test('an unreachable provider reports it instead of throwing', async () => {
  const { deps: d, err } = deps(fakeFetch({}))
  expect(await runModelsCommand(parseCliArgs(['models', 'openrouter']), d)).toBe(1)
  expect(err.join('\n')).toMatch(/tidak bisa dihubungi|could not be reached/)
})
