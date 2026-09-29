import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import type { CliArgs } from './args'
import { bccliHome, ConfigError, loadConfig, readCredentials, resolveModel } from './config'

type IntegrationTarget = 'opencode' | 'aider' | 'cline' | 'deepseek-harness'

export interface IntegrationDeps {
  env: NodeJS.ProcessEnv
  cwd: string
  out: (s: string) => void
  err: (s: string) => void
  fetch: typeof globalThis.fetch
}

interface StateRecord {
  target: IntegrationTarget
  files: Array<{ path: string; backup?: string; created: boolean }>
  createdAt: string
}

const BASE_URL = 'https://api.botconnector.id/v1'
const PROVIDER_ID = 'botconnector'

function integrationHome(env: NodeJS.ProcessEnv): string {
  return join(bccliHome(env), 'integrations')
}

function statePath(target: IntegrationTarget, env: NodeJS.ProcessEnv): string {
  return join(integrationHome(env), `${target}.state.json`)
}

function keyPath(env: NodeJS.ProcessEnv): string {
  return join(integrationHome(env), 'bc-cloud.key')
}

function parseTarget(raw: string | undefined): IntegrationTarget {
  if (raw === 'opencode' || raw === 'aider' || raw === 'cline' || raw === 'deepseek-harness') return raw
  if (raw === 'dsh') return 'deepseek-harness'
  throw new ConfigError('Agent harus salah satu dari: opencode, aider, cline, deepseek-harness (alias: dsh)')
}

function homeDir(env: NodeJS.ProcessEnv): string {
  const value = env.HOME || env.USERPROFILE
  if (!value) throw new ConfigError('Home directory tidak dapat ditentukan.')
  return value
}

function ensureSecret(env: NodeJS.ProcessEnv): string {
  const key = readCredentials(env)['bc-cloud'] || env.BOTCONNECTOR_API_KEY
  if (!key) throw new ConfigError('API key BotConnector belum tersedia. Jalankan bccli login bc-cloud terlebih dahulu.')
  const dir = integrationHome(env)
  mkdirSync(dir, { recursive: true })
  const path = keyPath(env)
  writeFileSync(path, `${key}\n`, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
  return path
}

function safeBackup(path: string, env: NodeJS.ProcessEnv): { backup?: string; created: boolean } {
  if (!existsSync(path)) return { created: true }
  const dir = integrationHome(env)
  mkdirSync(dir, { recursive: true })
  const name = path.split(/[\\/]/).pop() || 'config'
  const backup = join(dir, `${name}.${Date.now()}.bak`)
  copyFileSync(path, backup)
  return { backup, created: false }
}

function writeState(target: IntegrationTarget, state: StateRecord, env: NodeJS.ProcessEnv): void {
  const path = statePath(target, env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

function readState(target: IntegrationTarget, env: NodeJS.ProcessEnv): StateRecord | null {
  const path = statePath(target, env)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) as StateRecord } catch { return null }
}

async function botConnectorModels(deps: IntegrationDeps): Promise<string[]> {
  const config = loadConfig(deps.cwd)
  const resolved = resolveModel(config, config.model, deps.env)
  const key = readCredentials(deps.env)['bc-cloud'] || resolved.apiKey
  if (!key) throw new ConfigError('API key BotConnector belum tersedia. Jalankan bccli login bc-cloud terlebih dahulu.')
  // External agents call BotConnector directly, so model discovery must not
  // inherit BCCLI-only access (for example Luna launch access).
  const response = await deps.fetch(`${BASE_URL}/models`, {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!response.ok) throw new ConfigError(`Katalog model BotConnector gagal dimuat (HTTP ${response.status}).`)
  const payload = await response.json() as { data?: Array<{ id?: string }> }
  return (payload.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string' && !!id)
}

async function connectOpenCode(deps: IntegrationDeps): Promise<void> {
  const home = homeDir(deps.env)
  const path = join(home, '.config', 'opencode', 'opencode.json')
  const backup = safeBackup(path, deps.env)
  const secret = ensureSecret(deps.env)
  const models = await botConnectorModels(deps)

  let doc: Record<string, unknown> = {}
  if (existsSync(path)) {
    try { doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
    catch { throw new ConfigError(`Config OpenCode tidak valid JSON: ${path}`) }
  }
  const providers = (doc.provider && typeof doc.provider === 'object' && !Array.isArray(doc.provider))
    ? { ...(doc.provider as Record<string, unknown>) }
    : {}

  providers[PROVIDER_ID] = {
    npm: '@ai-sdk/openai-compatible',
    name: 'BotConnector',
    options: {
      baseURL: BASE_URL,
      apiKey: `{file:${secret.replace(/\\/g, '/')}}`,
    },
    models: Object.fromEntries(models.map((id) => [id, { name: id }])),
  }
  if (!doc.$schema) doc.$schema = 'https://opencode.ai/config.json'
  doc.provider = providers

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
  writeState('opencode', {
    target: 'opencode',
    files: [{ path, ...backup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out(`OpenCode terhubung ke BotConnector (${models.length} model).`)
  deps.out(`Config: ${path}`)
}

const AIDER_BEGIN = '# BEGIN BCCLI BOTCONNECTOR'
const AIDER_END = '# END BCCLI BOTCONNECTOR'

function stripManagedBlock(input: string): string {
  const start = input.indexOf(AIDER_BEGIN)
  if (start < 0) return input
  const end = input.indexOf(AIDER_END, start)
  if (end < 0) return input
  const after = end + AIDER_END.length
  const left = input.slice(0, start).trimEnd()
  const right = input.slice(after).trimStart()
  return right ? `${left}\n${right}` : left
}

function yamlQuote(value: string): string {
  return JSON.stringify(value.replace(/\\/g, '/'))
}

async function connectAider(deps: IntegrationDeps): Promise<void> {
  const home = homeDir(deps.env)
  const configPath = join(home, '.aider.conf.yml')
  const envPath = join(integrationHome(deps.env), 'aider.env')
  const configBackup = safeBackup(configPath, deps.env)
  const envBackup = safeBackup(envPath, deps.env)
  const secret = ensureSecret(deps.env)
  const key = readFileSync(secret, 'utf8').trim()
  const config = loadConfig(deps.cwd)
  const defaultModel = config.model.startsWith('bc-cloud/') ? config.model.slice('bc-cloud/'.length) : 'glm-5.3-flash'

  let existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  existing = stripManagedBlock(existing)
  if (/^\s*(env-file|openai-api-base|openai-api-key)\s*:/m.test(existing)) {
    throw new ConfigError(`Config Aider sudah memiliki env-file/openai-api setting sendiri: ${configPath}. BCCLI tidak akan menimpanya.`)
  }

  mkdirSync(dirname(envPath), { recursive: true })
  writeFileSync(envPath, [
    `OPENAI_API_BASE=${BASE_URL}`,
    `OPENAI_API_KEY=${key}`,
    `AIDER_MODEL=openai/${defaultModel}`,
    '',
  ].join('\n'), { mode: 0o600 })
  try { chmodSync(envPath, 0o600) } catch {}

  const managed = [
    AIDER_BEGIN,
    `env-file: ${yamlQuote(envPath)}`,
    AIDER_END,
  ].join('\n')
  const merged = existing.trim() ? `${existing.trimEnd()}\n\n${managed}\n` : `${managed}\n`
  writeFileSync(configPath, merged)
  writeState('aider', {
    target: 'aider',
    files: [{ path: configPath, ...configBackup }, { path: envPath, ...envBackup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out('Aider terhubung ke BotConnector.')
  deps.out(`Config: ${configPath}`)
}


function externalDefaultModel(models: string[], deps: IntegrationDeps): string {
  const config = loadConfig(deps.cwd)
  const preferred = config.model.startsWith('bc-cloud/') ? config.model.slice('bc-cloud/'.length) : ''
  if (preferred && models.includes(preferred)) return preferred
  const first = models[0]
  if (!first) throw new ConfigError('Katalog BotConnector tidak memiliki model yang dapat dipakai agent eksternal.')
  return first
}

async function connectCline(deps: IntegrationDeps): Promise<void> {
  const home = homeDir(deps.env)
  const dataDir = deps.env.CLINE_DATA_DIR || join(home, '.cline', 'data')
  const path = join(dataDir, 'settings', 'providers.json')
  const backup = safeBackup(path, deps.env)
  const secret = ensureSecret(deps.env)
  const key = readFileSync(secret, 'utf8').trim()
  const models = await botConnectorModels(deps)
  const model = externalDefaultModel(models, deps)

  let doc: Record<string, unknown> = { version: 1, modes: {}, providers: {} }
  if (existsSync(path)) {
    try { doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
    catch { throw new ConfigError('Config Cline tidak valid JSON: ' + path) }
  }
  const providers = (doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers))
    ? { ...(doc.providers as Record<string, unknown>) }
    : {}
  const current = providers['openai-compatible'] as { settings?: { baseUrl?: string } } | undefined
  const currentBase = current?.settings?.baseUrl
  if (currentBase && currentBase.replace(/\/+$/, '') !== BASE_URL) {
    throw new ConfigError(
      'Cline sudah memakai provider openai-compatible lain (' + currentBase + '). ' +
      'BCCLI tidak akan menimpanya; disconnect/ubah provider tersebut lebih dulu.',
    )
  }

  providers['openai-compatible'] = {
    settings: { provider: 'openai-compatible', apiKey: key, model, baseUrl: BASE_URL },
    updatedAt: new Date().toISOString(),
    tokenSource: 'manual',
  }
  doc.version = typeof doc.version === 'number' ? doc.version : 1
  doc.lastUsedProvider = 'openai-compatible'
  doc.modes = (doc.modes && typeof doc.modes === 'object') ? doc.modes : {}
  doc.providers = providers

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
  writeState('cline', {
    target: 'cline',
    files: [{ path, ...backup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out('Cline terhubung ke BotConnector (' + models.length + ' model tersedia; default ' + model + ').')
  deps.out('Config: ' + path)
  deps.out('Catatan: Cline menyimpan API key provider di providers.json miliknya.')
}

const DSH_ENV_BEGIN = '# BEGIN BCCLI BOTCONNECTOR'
const DSH_ENV_END = '# END BCCLI BOTCONNECTOR'

function stripDshEnvBlock(input: string): string {
  const start = input.indexOf(DSH_ENV_BEGIN)
  if (start < 0) return input
  const end = input.indexOf(DSH_ENV_END, start)
  if (end < 0) return input
  const after = end + DSH_ENV_END.length
  const left = input.slice(0, start).trimEnd()
  const right = input.slice(after).trimStart()
  return right ? left + '\n' + right : left
}

async function connectDeepSeekHarness(deps: IntegrationDeps): Promise<void> {
  const home = homeDir(deps.env)
  const dshHome = deps.env.DSH_HOME || join(home, '.dsh')
  const settingsPath = join(dshHome, 'settings.yaml')
  const envPath = join(dshHome, '.env')
  const settingsBackup = safeBackup(settingsPath, deps.env)
  const envBackup = safeBackup(envPath, deps.env)
  const secret = ensureSecret(deps.env)
  const key = readFileSync(secret, 'utf8').trim()
  const models = await botConnectorModels(deps)

  const source = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '{}\n'
  const doc = parseDocument(source)
  if (doc.errors.length) throw new ConfigError('Config DeepSeek Harness tidak valid YAML: ' + settingsPath)

  const existingProvider = doc.getIn(['llm-pi-ai', 'providers', PROVIDER_ID]) as { baseURL?: string } | undefined
  if (existingProvider?.baseURL && existingProvider.baseURL.replace(/\/+$/, '') !== BASE_URL) {
    throw new ConfigError('DeepSeek Harness sudah memiliki provider "' + PROVIDER_ID + '" dengan endpoint lain.')
  }

  doc.setIn(['llm-pi-ai', 'providers', PROVIDER_ID], {
    displayName: 'BotConnector',
    apiKeyEnv: 'BOTCONNECTOR_API_KEY',
    api: 'openai-completions',
    baseURL: BASE_URL,
    defaultInput: ['text'],
    compat: { supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    models: models.map((id) => ({ id, name: id })),
  })

  let envText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  envText = stripDshEnvBlock(envText)
  if (/^\s*BOTCONNECTOR_API_KEY\s*=/m.test(envText)) {
    throw new ConfigError('$DSH_HOME/.env sudah memiliki BOTCONNECTOR_API_KEY di luar blok BCCLI: ' + envPath)
  }
  const managed = [DSH_ENV_BEGIN, 'BOTCONNECTOR_API_KEY=' + key, DSH_ENV_END].join('\n')
  const mergedEnv = envText.trim() ? envText.trimEnd() + '\n\n' + managed + '\n' : managed + '\n'

  mkdirSync(dshHome, { recursive: true })
  writeFileSync(settingsPath, doc.toString())
  writeFileSync(envPath, mergedEnv, { mode: 0o600 })
  try { chmodSync(envPath, 0o600) } catch {}
  writeState('deepseek-harness', {
    target: 'deepseek-harness',
    files: [{ path: settingsPath, ...settingsBackup }, { path: envPath, ...envBackup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out('DeepSeek Harness terhubung ke BotConnector (' + models.length + ' model).')
  deps.out('Config: ' + settingsPath)
  deps.out('Provider: botconnector (OpenAI Chat Completions)')
}

function disconnect(target: IntegrationTarget, deps: IntegrationDeps): void {
  const state = readState(target, deps.env)
  if (!state) {
    deps.out(`${target}: belum dikelola oleh BCCLI.`)
    return
  }
  for (const file of [...state.files].reverse()) {
    if (file.backup && existsSync(file.backup)) {
      mkdirSync(dirname(file.path), { recursive: true })
      copyFileSync(file.backup, file.path)
    } else if (file.created) {
      rmSync(file.path, { force: true })
    }
  }
  rmSync(statePath(target, deps.env), { force: true })
  deps.out(`${target}: integrasi BotConnector dilepas dan config dipulihkan.`)
}

function listIntegrations(deps: IntegrationDeps): void {
  for (const target of ['opencode', 'aider', 'cline', 'deepseek-harness'] as const) {
    deps.out(`${target}\t${readState(target, deps.env) ? 'connected' : 'not connected'}`)
  }
}

export async function runIntegrationCommand(args: CliArgs, deps: IntegrationDeps): Promise<number> {
  if (args.command === 'integrations') {
    listIntegrations(deps)
    return 0
  }
  const target = parseTarget(args.subArgs[0])
  if (args.command === 'disconnect') {
    disconnect(target, deps)
    return 0
  }
  if (target === 'opencode') await connectOpenCode(deps)
  else if (target === 'aider') await connectAider(deps)
  else if (target === 'cline') await connectCline(deps)
  else await connectDeepSeekHarness(deps)
  return 0
}
