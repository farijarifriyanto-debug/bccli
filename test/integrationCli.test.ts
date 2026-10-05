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
  const output: string[] = []
  const deps = { env: ee, cwd: e.HOME, out: (s: string) => output.push(s), err: () => {}, fetch }
  await runIntegrationCommand(parseCliArgs(['connect', 'dsh']), deps)
  expect(output).toContain('Jalankan: dsh web')
  expect(output).toContain('Bentuk panjang yang setara: dsh --profile web')
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


test('connect openai-sdk writes dedicated env profile and disconnect removes it', async () => {
  const e = env()
  saveCredential('bc-cloud', 'bc_live_secret', e)
  const deps = { env: e, cwd: e.HOME, out: () => {}, err: () => {}, fetch: vi.fn() }
  await runIntegrationCommand(parseCliArgs(['connect', 'openai-sdk']), deps)
  const path = join(e.BCCLI_HOME, 'integrations', 'openai-sdk.env')
  const text = readFileSync(path, 'utf8')
  expect(text).toContain('OPENAI_BASE_URL=https://api.botconnector.id/v1')
  expect(text).toContain('OPENAI_API_KEY=bc_live_secret')
  await runIntegrationCommand(parseCliArgs(['disconnect', 'openai-sdk']), deps)
  expect(() => readFileSync(path, 'utf8')).toThrow()
})

test('connect openai-compatible writes universal env profile', async () => {
  const e = env()
  saveCredential('bc-cloud', 'bc_live_secret', e)
  await runIntegrationCommand(parseCliArgs(['connect', 'openai-compatible']), {
    env: e, cwd: e.HOME, out: () => {}, err: () => {}, fetch: vi.fn(),
  })
  const text = readFileSync(join(e.BCCLI_HOME, 'integrations', 'openai-compatible.env'), 'utf8')
  expect(text).toContain('OPENAI_BASE_URL=https://api.botconnector.id/v1')
  expect(text).toContain('OPENAI_API_KEY=bc_live_secret')
})

test('connect cursor creates guided profile without embedding the API key', async () => {
  const e = env()
  saveCredential('bc-cloud', 'bc_live_secret', e)
  await runIntegrationCommand(parseCliArgs(['connect', 'cursor']), {
    env: e, cwd: e.HOME, out: () => {}, err: () => {}, fetch: vi.fn(),
  })
  const text = readFileSync(join(e.BCCLI_HOME, 'integrations', 'cursor.txt'), 'utf8')
  expect(text).toContain('Override OpenAI Base URL')
  expect(text).toContain('https://api.botconnector.id/v1')
  expect(text).toContain('API key file:')
  expect(text).not.toContain('bc_live_secret')
})

test('connect openai-cli creates launcher that reads the BCCLI key file', async () => {
  const e = env()
  saveCredential('bc-cloud', 'bc_live_secret', e)
  await runIntegrationCommand(parseCliArgs(['connect', 'openai-cli']), {
    env: e, cwd: e.HOME, out: () => {}, err: () => {}, fetch: vi.fn(),
  })
  const ext = process.platform === 'win32' ? '.cmd' : ''
  const text = readFileSync(join(e.BCCLI_HOME, 'integrations', `openai-botconnector${ext}`), 'utf8')
  expect(text).toContain('OPENAI_BASE_URL')
  expect(text).toContain('openai')
  expect(text).not.toContain('bc_live_secret')
})


test('connect codex creates Responses provider profile and keyless launcher', async () => {
  const e = env()
  const codexHome = join(e.HOME, '.codex-test')
  const ee = { ...e, CODEX_HOME: codexHome }
  saveCredential('bc-cloud', 'bc_live_secret', ee)
  mkdirSync(codexHome, { recursive: true })
  const originalConfig = 'approval_policy = "on-request"\n'
  writeFileSync(join(codexHome, 'config.toml'), originalConfig)
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: [{ id: 'agnes-3.0-flash' }, { id: 'ling-3.0-flash' }, { id: 'mimo-v2.5' }],
  }), { status: 200 }))
  const deps = { env: ee, cwd: e.HOME, out: () => {}, err: () => {}, fetch }
  await runIntegrationCommand(parseCliArgs(['connect', 'codex']), deps)

  const profilePath = join(codexHome, 'botconnector.config.toml')
  const ext = process.platform === 'win32' ? '.cmd' : ''
  const launcherPath = join(e.BCCLI_HOME, 'integrations', `codex-botconnector${ext}`)
  const profile = readFileSync(profilePath, 'utf8')
  const launcher = readFileSync(launcherPath, 'utf8')
  expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(originalConfig)
  expect(profile).toContain('[model_providers.botconnector]')
  expect(profile).toContain('wire_api = "responses"')
  expect(profile).toContain('env_key = "BOTCONNECTOR_API_KEY"')
  expect(profile).toContain('base_url = "https://api.botconnector.id/v1"')
  expect(profile).toContain('model = "ling-3.0-flash"')
  expect(profile).not.toContain('bc_live_secret')
  expect(launcher).toContain('codex -p botconnector')
  expect(launcher).not.toContain('bc_live_secret')

  await runIntegrationCommand(parseCliArgs(['disconnect', 'codex']), deps)
  expect(() => readFileSync(profilePath, 'utf8')).toThrow()
  expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toBe(originalConfig)
  expect(() => readFileSync(launcherPath, 'utf8')).toThrow()
})

test('connect claude-code creates Messages launcher without embedding key', async () => {
  const e = env()
  saveCredential('bc-cloud', 'bc_live_secret', e)
  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: [{ id: 'agnes-3.0-flash' }, { id: 'ling-3.0-flash' }],
  }), { status: 200 }))
  const deps = { env: e, cwd: e.HOME, out: () => {}, err: () => {}, fetch }
  await runIntegrationCommand(parseCliArgs(['connect', 'claude-code']), deps)

  const ext = process.platform === 'win32' ? '.cmd' : ''
  const launcherPath = join(e.BCCLI_HOME, 'integrations', `claude-botconnector${ext}`)
  const launcher = readFileSync(launcherPath, 'utf8')
  expect(launcher).toContain('ANTHROPIC_BASE_URL')
  expect(launcher).toContain('https://api.botconnector.id')
  expect(launcher).toContain('ANTHROPIC_MODEL')
  expect(launcher).toContain('ling-3.0-flash')
  expect(launcher).toContain('ANTHROPIC_AUTH_TOKEN')
  expect(launcher).toContain('claude')
  expect(launcher).not.toContain('bc_live_secret')

  await runIntegrationCommand(parseCliArgs(['disconnect', 'claude-code']), deps)
  expect(() => readFileSync(launcherPath, 'utf8')).toThrow()
})


test('connect hermes writes custom BotConnector model config and keeps the key out of YAML', async () => {
  const e = env()
  const hermesHome = join(e.HOME, '.hermes-test')
  const ee = { ...e, HERMES_HOME: hermesHome }
  saveCredential('bc-cloud', 'bc_live_secret', ee)
  mkdirSync(hermesHome, { recursive: true })
  const configPath = join(hermesHome, 'config.yaml')
  const envPath = join(hermesHome, '.env')
  const originalConfig = 'other: keep\n'
  const originalEnv = 'OTHER=value\n'
  writeFileSync(configPath, originalConfig)
  writeFileSync(envPath, originalEnv)

  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: [
      { id: 'agnes-3.0-flash', capabilities: ['Tools', 'Vision', 'Reasoning'], context: 524288 },
      { id: 'glm-5.3-flash' },
    ],
  }), { status: 200 }))
  const output: string[] = []
  const deps = { env: ee, cwd: e.HOME, out: (line: string) => output.push(line), err: () => {}, fetch }

  await runIntegrationCommand(parseCliArgs(['connect', 'hermes']), deps)

  const yaml = readFileSync(configPath, 'utf8')
  const henv = readFileSync(envPath, 'utf8')
  expect(yaml).toContain('other: keep')
  expect(yaml).toContain('provider: custom')
  expect(yaml).toContain('base_url: https://api.botconnector.id/v1')
  expect(yaml).toContain('key_env: BOTCONNECTOR_API_KEY')
  expect(yaml).toContain('default: agnes-3.0-flash')
  expect(yaml).toContain('provider: main')
  expect(yaml).not.toContain('bc_live_secret')
  expect(henv).toContain('OTHER=value')
  expect(henv).toContain('BOTCONNECTOR_API_KEY=bc_live_secret')
  expect(output.some((line) => line.includes('Hermes'))).toBe(true)

  await runIntegrationCommand(parseCliArgs(['disconnect', 'hermes']), deps)
  expect(readFileSync(configPath, 'utf8')).toBe(originalConfig)
  expect(readFileSync(envPath, 'utf8')).toBe(originalEnv)
})

test('connect openclaw merges BotConnector provider with SecretRef and model metadata', async () => {
  const e = env()
  const stateDir = join(e.HOME, '.openclaw-test')
  const ee = { ...e, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_ID: 'main' }
  saveCredential('bc-cloud', 'bc_live_secret', ee)
  const agentDir = join(stateDir, 'agents', 'main', 'agent')
  mkdirSync(agentDir, { recursive: true })
  const modelsPath = join(agentDir, 'models.json')
  const envPath = join(stateDir, '.env')
  const originalModels = JSON.stringify({
    providers: {
      keep: { baseUrl: 'https://keep.example/v1', api: 'openai-completions', models: [{ id: 'keep-model' }] },
    },
  }, null, 2) + '\n'
  const originalEnv = 'OTHER=value\n'
  writeFileSync(modelsPath, originalModels)
  writeFileSync(envPath, originalEnv)

  const fetch = vi.fn(async () => new Response(JSON.stringify({
    data: [
      {
        id: 'agnes-3.0-flash',
        name: 'Agnes 3.0 Flash',
        capabilities: ['Tools', 'Vision', 'Reasoning'],
        context: 524288,
        max_tokens: 32768,
      },
      { id: 'glm-5.3-flash', capabilities: ['Tools'] },
    ],
  }), { status: 200 }))
  const output: string[] = []
  const deps = { env: ee, cwd: e.HOME, out: (line: string) => output.push(line), err: () => {}, fetch }

  await runIntegrationCommand(parseCliArgs(['connect', 'openclaw']), deps)

  const doc = JSON.parse(readFileSync(modelsPath, 'utf8'))
  const provider = doc.providers.botconnector
  expect(doc.providers.keep).toBeTruthy()
  expect(provider.baseUrl).toBe('https://api.botconnector.id/v1')
  expect(provider.api).toBe('openai-completions')
  expect(provider.apiKey).toEqual({ source: 'env', provider: 'default', id: 'BOTCONNECTOR_API_KEY' })
  expect(provider.models[0]).toMatchObject({
    id: 'agnes-3.0-flash',
    name: 'Agnes 3.0 Flash',
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 524288,
    maxTokens: 32768,
  })
  expect(readFileSync(modelsPath, 'utf8')).not.toContain('bc_live_secret')
  expect(readFileSync(envPath, 'utf8')).toContain('BOTCONNECTOR_API_KEY=bc_live_secret')
  expect(output).toContain('Set default: openclaw models set botconnector/agnes-3.0-flash')

  await runIntegrationCommand(parseCliArgs(['disconnect', 'openclaw']), deps)
  expect(readFileSync(modelsPath, 'utf8')).toBe(originalModels)
  expect(readFileSync(envPath, 'utf8')).toBe(originalEnv)
})

test('parses hermes and openclaw integration targets', () => {
  expect(parseCliArgs(['connect', 'hermes']).subArgs).toEqual(['hermes'])
  expect(parseCliArgs(['connect', 'openclaw']).subArgs).toEqual(['openclaw'])
})
