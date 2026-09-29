import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { parseCliArgs } from '../src/args'
import { saveCredential } from '../src/config'
import { runIntegrationCommand } from '../src/integrationCli'

function env() {
  const home = mkdtempSync(join(tmpdir(), 'bccli-int-'))
  return { HOME: home, USERPROFILE: home, BCCLI_HOME: join(home, '.bccli') }
}

test('parses connect and disconnect commands', () => {
  expect(parseCliArgs(['connect', 'opencode']).command).toBe('connect')
  expect(parseCliArgs(['connect', 'opencode']).subArgs).toEqual(['opencode'])
  expect(parseCliArgs(['disconnect', 'aider']).command).toBe('disconnect')
})

test('connect opencode merges existing config and stores key by file reference', async () => {
  const e = env()
  saveCredential('bc-cloud', 'bc_live_secret', e)
  const configPath = join(e.HOME, '.config', 'opencode', 'opencode.json')
  mkdirSync(join(e.HOME, '.config', 'opencode'), { recursive: true })
  writeFileSync(configPath, JSON.stringify({ theme: 'system', provider: { keep: { name: 'Keep' } } }))

  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: [{ id: 'glm-5.3-flash' }, { id: 'gpt-6-luna' }],
  }), { status: 200 }))
  await runIntegrationCommand(parseCliArgs(['connect', 'opencode']), {
    env: e, cwd: e.HOME, out: () => {}, err: () => {}, fetch,
  })
  const doc = JSON.parse(readFileSync(configPath, 'utf8'))
  expect(doc.theme).toBe('system')
  expect(doc.provider.keep.name).toBe('Keep')
  expect(doc.provider.botconnector.options.baseURL).toBe('https://api.botconnector.id/v1')
  expect(doc.provider.botconnector.options.apiKey).toContain('{file:')
  expect(doc.provider.botconnector.models['glm-5.3-flash']).toBeTruthy()
  expect(readFileSync(configPath, 'utf8')).not.toContain('bc_live_secret')
})

test('disconnect opencode restores prior config', async () => {
  const e = env()
  saveCredential('bc-cloud', 'bc_live_secret', e)
  const dir = join(e.HOME, '.config', 'opencode')
  mkdirSync(dir, { recursive: true })
  const configPath = join(dir, 'opencode.json')
  writeFileSync(configPath, '{"theme":"original"}\n')
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: [{ id: 'glm-5.3-flash' }],
  }), { status: 200 }))
  const deps = { env: e, cwd: e.HOME, out: () => {}, err: () => {}, fetch }
  await runIntegrationCommand(parseCliArgs(['connect', 'opencode']), deps)
  await runIntegrationCommand(parseCliArgs(['disconnect', 'opencode']), deps)
  expect(readFileSync(configPath, 'utf8')).toBe('{"theme":"original"}\n')
})

test('connect aider uses dedicated env file and does not put key in yaml', async () => {
  const e = env()
  saveCredential('bc-cloud', 'bc_live_secret', e)
  await runIntegrationCommand(parseCliArgs(['connect', 'aider']), {
    env: e, cwd: e.HOME, out: () => {}, err: () => {}, fetch: vi.fn(),
  })
  const yml = readFileSync(join(e.HOME, '.aider.conf.yml'), 'utf8')
  const envFile = readFileSync(join(e.BCCLI_HOME, 'integrations', 'aider.env'), 'utf8')
  expect(yml).toContain('env-file:')
  expect(yml).not.toContain('bc_live_secret')
  expect(envFile).toContain('OPENAI_API_BASE=https://api.botconnector.id/v1')
  expect(envFile).toContain('OPENAI_API_KEY=bc_live_secret')
})

test('aider refuses to overwrite existing provider settings', async () => {
  const e = env()
  saveCredential('bc-cloud', 'bc_live_secret', e)
  writeFileSync(join(e.HOME, '.aider.conf.yml'), 'openai-api-base: https://example.test/v1\n')
  await expect(runIntegrationCommand(parseCliArgs(['connect', 'aider']), {
    env: e, cwd: e.HOME, out: () => {}, err: () => {}, fetch: vi.fn(),
  })).rejects.toThrow(/tidak akan menimpanya/)
})
