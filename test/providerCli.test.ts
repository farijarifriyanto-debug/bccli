import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { parseCliArgs } from '../src/args'
import { loadConfig, readCredentials } from '../src/config'
import { type CliDeps, runProviderCommand } from '../src/providerCli'

function deps(secret = 'sk-test', status = 200): CliDeps & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return {
    env: { BCCLI_HOME: mkdtempSync(join(tmpdir(), 'bccli-pcli-')) },
    cwd: mkdtempSync(join(tmpdir(), 'bccli-pcw-')),
    out: (s) => lines.push(s),
    err: (s) => errors.push(s),
    readSecret: async () => secret,
    fetch: (async () => new Response(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), { status })) as unknown as typeof fetch,
    lines,
    errors,
  }
}
const run = (argv: string[], d: CliDeps) => runProviderCommand(parseCliArgs(['provider', ...argv]), d)

test('list shows every preset with key status', async () => {
  const d = deps()
  d.env.OPENAI_API_KEY = 'x'
  expect(await run(['list'], d)).toBe(0)
  const text = d.lines.join('\n')
  expect(text).toMatch(/✓ openai/)
  expect(text).toMatch(/○ groq/)
  expect(text).toMatch(/✓ ollama/)
})

test('add <preset> asks the key, verifies it and saves it', async () => {
  const d = deps('sk-good')
  expect(await run(['add', 'groq'], d)).toBe(0)
  expect(readCredentials(d.env)).toEqual({ groq: 'sk-good' })
  expect(d.lines.join('\n')).toMatch(/2 model/)
})

test('a rejected key is not saved', async () => {
  const d = deps('sk-bad', 401)
  expect(await run(['add', 'groq'], d)).toBe(1)
  expect(readCredentials(d.env)).toEqual({})
})

test('add <custom> needs --url; writes config and key', async () => {
  const d = deps('')
  expect(await run(['add', 'corp'], d)).toBe(1)
  expect(await run(['add', 'corp', '--url', 'http://corp.local/v1', '--name', 'Corp'], d)).toBe(0)
  expect(loadConfig(d.cwd, d.env).providers.corp).toEqual({ baseURL: 'http://corp.local/v1', name: 'Corp' })
})

test('remove deletes a custom provider', async () => {
  const d = deps('')
  await run(['add', 'corp', '--url', 'http://corp.local/v1'], d)
  expect(await run(['remove', 'corp'], d)).toBe(0)
  expect(loadConfig(d.cwd, d.env).providers.corp).toBeUndefined()
})

test('the candidate key is what gets verified, also for custom providers without apiKeyEnv', async () => {
  const d = deps('sk-new')
  const seen: (string | null)[] = []
  d.fetch = (async (_url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get('authorization')
    seen.push(auth)
    return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: auth === 'Bearer sk-new' ? 200 : 401 })
  }) as unknown as typeof fetch
  expect(await run(['add', 'corp', '--url', 'http://corp.local/v1'], d)).toBe(0)
  expect(seen).toEqual(['Bearer sk-new'])
  expect(readCredentials(d.env)).toEqual({ corp: 'sk-new' })
})
