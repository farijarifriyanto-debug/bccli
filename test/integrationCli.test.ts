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
  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  const headers = init.headers as Record<string, string>
  expect(headers['x-botconnector-client']).toBeUndefined()
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
test('connect cline writes BotConnector openai-compatible provider and preserves other providers', async () => {
  const e = env()
  const dataDir = join(e.HOME, 'cline-data')
  const ee = { ...e, CLINE_DATA_DIR: dataDir }
  saveCredential('bc-cloud', 'bc_live_secret', ee)
  const path = join(dataDir, 'settings', 'providers.json')
  mkdirSync(join(dataDir, 'settings'), { recursive: true })
  writeFileSync(path, JSON.stringify({
    version: 1,
    providers: { keep: { settings: { provider: 'keep', apiKey: 'keep' } } },
  }))
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.8-flash' }],
  }), { status: 200 }))
  await runIntegrationCommand(parseCliArgs(['connect', 'cline']), {
    env: ee, cwd: e.HOME, out: () => {}, err: () => {}, fetch,
  })
  const doc = JSON.parse(readFileSync(path, 'utf8'))
  expect(doc.providers.keep).toBeTruthy()
  expect(doc.providers['openai-compatible'].settings.baseUrl).toBe('https://api.botconnector.id/v1')
  expect(doc.providers['openai-compatible'].settings.apiKey).toBe('bc_live_secret')
  expect(doc.providers['openai-compatible'].settings.model).toBe('glm-5.3-flash')
})
test('cline refuses to overwrite a different openai-compatible provider', async () => {
  const e = env()
  const dataDir = join(e.HOME, 'cline-data')
  const ee = { ...e, CLINE_DATA_DIR: dataDir }
  saveCredential('bc-cloud', 'bc_live_secret', ee)
  const path = join(dataDir, 'settings', 'providers.json')
  mkdirSync(join(dataDir, 'settings'), { recursive: true })
  writeFileSync(path, JSON.stringify({
    version: 1,
    providers: {
      'openai-compatible': { settings: { provider: 'openai-compatible', baseUrl: 'https://other.example/v1' } },
    },
  }))
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: [{ id: 'glm-5.3-flash' }],
  }), { status: 200 }))
  await expect(runIntegrationCommand(parseCliArgs(['connect', 'cline']), {
    env: ee, cwd: e.HOME, out: () => {}, err: () => {}, fetch,
  })).rejects.toThrow(/tidak akan menimpanya/)
})
test('connect dsh preserves existing provider and restores exact files on disconnect', async () => {
  const e = env()
  const dshHome = join(e.HOME, '.dsh-test')
  const ee = { ...e, DSH_HOME: dshHome }
  saveCredential('bc-cloud', 'bc_live_secret', ee)
  mkdirSync(dshHome, { recursive: true })
  const settingsPath = join(dshHome, 'settings.yaml')
  const envPath = join(dshHome, '.env')
  const originalSettings = 'llm-pi-ai:\n  providers:\n    ollama-local:\n      api: openai-completions\n      baseURL: http://127.0.0.1:11434/v1\n'
  const originalEnv = 'OTHER=value\n'
  writeFileSync(settingsPath, originalSettings)
  writeFileSync(envPath, originalEnv)
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.8-flash' }],
  }), { status: 200 }))
  const deps = { env: ee, cwd: e.HOME, out: () => {}, err: () => {}, fetch }
  await runIntegrationCommand(parseCliArgs(['connect', 'dsh']), deps)
  const yml = readFileSync(settingsPath, 'utf8')
  const denv = readFileSync(envPath, 'utf8')
  expect(yml).toContain('ollama-local')
  expect(yml).toContain('botconnector')
  expect(yml).toContain('apiKeyEnv: BOTCONNECTOR_API_KEY')
  expect(denv).toContain('OTHER=value')
  expect(denv).toContain('BOTCONNECTOR_API_KEY=bc_live_secret')
  await runIntegrationCommand(parseCliArgs(['disconnect', 'dsh']), deps)
  expect(readFileSync(settingsPath, 'utf8')).toBe(originalSettings)
  expect(readFileSync(envPath, 'utf8')).toBe(originalEnv)
})
