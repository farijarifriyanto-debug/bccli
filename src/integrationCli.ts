import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import type { CliArgs } from './args'
import { bccliHome, ConfigError, loadConfig, readCredentials, resolveModel } from './config'
import { t } from './i18n'

type IntegrationTarget = 'opencode' | 'aider' | 'cline' | 'deepseek-harness' | 'cursor' | 'openai-cli' | 'openai-sdk' | 'openai-compatible' | 'codex' | 'claude-code' | 'openclaw' | 'hermes'

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

const OPENCLAW_ENV_ID = 'BOTCONNECTOR_API_KEY'
const HERMES_ENV_ID = 'BOTCONNECTOR_API_KEY'
const HERMES_PROVIDER_ID = 'botconnector-cloud'
// Model used only when the live catalog is reachable but empty for this key;
// chat/tool-capable default that ships on every BotConnector plan.
const FALLBACK_DEFAULT_MODEL = 'glm-5.3-flash'

function parseTarget(raw: string | undefined): IntegrationTarget {
  if (
    raw === 'opencode' || raw === 'aider' || raw === 'cline' || raw === 'deepseek-harness' ||
    raw === 'cursor' || raw === 'openai-cli' || raw === 'openai-sdk' || raw === 'openai-compatible' ||
    raw === 'codex' || raw === 'claude-code' || raw === 'openclaw' || raw === 'hermes'
  ) return raw
  if (raw === 'dsh') return 'deepseek-harness'
  throw new ConfigError(
    t('Agent must be one of: opencode, aider, cline, deepseek-harness (dsh), cursor, openai-cli, openai-sdk, openai-compatible, codex, claude-code, openclaw, hermes'),
  )
}

function homeDir(env: NodeJS.ProcessEnv): string {
  const value = env.HOME || env.USERPROFILE
  if (!value) throw new ConfigError(t('Cannot determine the home directory.'))
  return value
}

function ensureSecret(env: NodeJS.ProcessEnv): string {
  const key = readCredentials(env)['bc-cloud'] || env.BOTCONNECTOR_API_KEY
  if (!key) throw new ConfigError(t('No BotConnector API key yet. Run bccli login bc-cloud first.'))
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
  const config = loadConfig(deps.cwd, deps.env)
  const resolved = resolveModel(config, config.model, deps.env)
  const key = readCredentials(deps.env)['bc-cloud'] || resolved.apiKey
  if (!key) throw new ConfigError(t('No BotConnector API key yet. Run bccli login bc-cloud first.'))
  // External agents call BotConnector directly, so model discovery must not
  // inherit BCCLI-only access (for example Luna launch access).
  const response = await deps.fetch(`${BASE_URL}/models`, {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!response.ok) throw new ConfigError(t('Could not load the BotConnector model catalog (HTTP {status}).', { status: response.status }))
  const payload = await response.json() as { data?: Array<{ id?: string }> }
  const models = (payload.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === 'string' && !!id)
  if (!models.length) throw new ConfigError(t('The BotConnector model catalog is empty; cannot configure external agents.'))
  return models
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
    catch { throw new ConfigError(t('The OpenCode config is not valid JSON: {path}', { path })) }
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
  deps.out(t('OpenCode is connected to BotConnector ({n} models).', { n: models.length }))
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

/**
 * Resolve the default model for an external agent config.
 * Preferred: the BCCLI user's current bc-cloud model when the upstream
 * catalog confirms it. Fallback: a static chat/tool-capable constant.
 * No model list or context-window numbers are ever written into configs.
 */
function externalAgentDefaultModel(models: string[], deps: IntegrationDeps): string {
  try {
    const config = loadConfig(deps.cwd, deps.env)
    const preferred = config.model.startsWith('bc-cloud/') ? config.model.slice('bc-cloud/'.length) : ''
    if (preferred && models.includes(preferred)) return preferred
  } catch {
    // BCCLI config unreadable: the catalog default still applies below.
  }
  return models.includes(FALLBACK_DEFAULT_MODEL) ? FALLBACK_DEFAULT_MODEL : models[0]
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
    throw new ConfigError(t('The Aider config already has its own env-file/openai-api settings: {path}. BCCLI will not overwrite them.', { path: configPath }))
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
  deps.out(t('Aider is connected to BotConnector.'))
  deps.out(`Config: ${configPath}`)
}


function externalDefaultModel(models: string[], deps: IntegrationDeps): string {
  const config = loadConfig(deps.cwd)
  const preferred = config.model.startsWith('bc-cloud/') ? config.model.slice('bc-cloud/'.length) : ''
  if (preferred && models.includes(preferred)) return preferred
  const first = models[0]
  if (!first) throw new ConfigError(t('The BotConnector catalog has no model that external agents can use.'))
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
    catch { throw new ConfigError(t('The Cline config is not valid JSON: {path}', { path })) }
  }
  const providers = (doc.providers && typeof doc.providers === 'object' && !Array.isArray(doc.providers))
    ? { ...(doc.providers as Record<string, unknown>) }
    : {}
  const current = providers['openai-compatible'] as { settings?: { baseUrl?: string } } | undefined
  const currentBase = current?.settings?.baseUrl
  if (currentBase && currentBase.replace(/\/+$/, '') !== BASE_URL) {
    throw new ConfigError(
      t('Cline already uses another openai-compatible provider ({base}). BCCLI will not overwrite it; disconnect or change that provider first.', { base: currentBase }),
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
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
  writeState('cline', {
    target: 'cline',
    files: [{ path, ...backup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out(t('Cline is connected to BotConnector ({n} models available; default {model}).', { n: models.length, model }))
  deps.out(`Config: ${path}`)
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
  return right ? `${left}\n${right}` : left
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
  if (doc.errors.length) throw new ConfigError(t('The DeepSeek Harness config is not valid YAML: {path}', { path: settingsPath }))

  const existingProvider = doc.getIn(['llm-pi-ai', 'providers', PROVIDER_ID]) as { baseURL?: string } | undefined
  if (existingProvider?.baseURL && existingProvider.baseURL.replace(/\/+$/, '') !== BASE_URL) {
    throw new ConfigError(t('DeepSeek Harness already has a provider "{id}" with a different endpoint.', { id: PROVIDER_ID }))
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
    throw new ConfigError(t('$DSH_HOME/.env already has BOTCONNECTOR_API_KEY outside the BCCLI block: {path}', { path: envPath }))
  }
  const managed = [DSH_ENV_BEGIN, `BOTCONNECTOR_API_KEY=${key}`, DSH_ENV_END].join('\n')
  const mergedEnv = envText.trim() ? `${envText.trimEnd()}\n\n${managed}\n` : `${managed}\n`

  mkdirSync(dshHome, { recursive: true })
  writeFileSync(settingsPath, doc.toString())
  writeFileSync(envPath, mergedEnv, { mode: 0o600 })
  try { chmodSync(envPath, 0o600) } catch {}
  writeState('deepseek-harness', {
    target: 'deepseek-harness',
    files: [{ path: settingsPath, ...settingsBackup }, { path: envPath, ...envBackup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out(t('DeepSeek Harness is connected to BotConnector ({n} models).', { n: models.length }))
  deps.out(`Config: ${settingsPath}`)
  deps.out('Provider: botconnector (OpenAI Chat Completions)')
  deps.out(t('Run: dsh web'))
  deps.out(t('Equivalent long form: dsh --profile web'))
}


function managedProfilePath(target: IntegrationTarget, env: NodeJS.ProcessEnv, ext = 'env'): string {
  return join(integrationHome(env), `${target}.${ext}`)
}

function writeOpenAiEnvProfile(target: IntegrationTarget, deps: IntegrationDeps): string {
  const secret = ensureSecret(deps.env)
  const key = readFileSync(secret, 'utf8').trim()
  const path = managedProfilePath(target, deps.env)
  const backup = safeBackup(path, deps.env)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    `OPENAI_BASE_URL=${BASE_URL}`,
    `OPENAI_API_KEY=${key}`,
    '',
  ].join('\n'), { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch {}
  writeState(target, {
    target,
    files: [{ path, ...backup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  return path
}

async function connectOpenAiCli(deps: IntegrationDeps): Promise<void> {
  const secret = ensureSecret(deps.env)
  const dir = integrationHome(deps.env)
  const launcher = join(dir, process.platform === 'win32' ? 'openai-botconnector.cmd' : 'openai-botconnector')
  const backup = safeBackup(launcher, deps.env)
  mkdirSync(dir, { recursive: true })

  if (process.platform === 'win32') {
    const keyFile = secret.replace(/\//g, '\\')
    writeFileSync(launcher, [
      '@echo off',
      `set "OPENAI_BASE_URL=${BASE_URL}"`,
      `for /f "usebackq delims=" %%A in ("${keyFile}") do set "OPENAI_API_KEY=%%A"`,
      'openai %*',
      '',
    ].join('\r\n'))
  } else {
    const keyFile = secret.replace(/'/g, "'\\''")
    writeFileSync(launcher, [
      '#!/bin/sh',
      `export OPENAI_BASE_URL='${BASE_URL}'`,
      `export OPENAI_API_KEY="$(cat '${keyFile}')"`,
      'exec openai "$@"',
      '',
    ].join('\n'), { mode: 0o700 })
    try { chmodSync(launcher, 0o700) } catch {}
  }

  writeState('openai-cli', {
    target: 'openai-cli',
    files: [{ path: launcher, ...backup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out('OpenAI CLI profile BotConnector siap.')
  deps.out(`Launcher: ${launcher}`)
  deps.out(t('The launcher does not store the API key in the script; the key is read from BCCLI storage when it runs.'))
}

async function connectOpenAiSdk(deps: IntegrationDeps): Promise<void> {
  const path = writeOpenAiEnvProfile('openai-sdk', deps)
  deps.out('OpenAI SDK profile BotConnector siap.')
  deps.out(`Env profile: ${path}`)
  deps.out(t('The Python and Node OpenAI SDKs can read OPENAI_BASE_URL and OPENAI_API_KEY from this profile.'))
}

async function connectOpenAiCompatible(deps: IntegrationDeps): Promise<void> {
  const path = writeOpenAiEnvProfile('openai-compatible', deps)
  deps.out('Profile OpenAI-compatible BotConnector siap.')
  deps.out(`Env profile: ${path}`)
  deps.out(`Base URL: ${BASE_URL}`)
}

async function connectCursor(deps: IntegrationDeps): Promise<void> {
  const secret = ensureSecret(deps.env)
  const path = managedProfilePath('cursor', deps.env, 'txt')
  const backup = safeBackup(path, deps.env)
  const keyFile = secret.replace(/\\/g, '/')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    'BotConnector -> Cursor guided setup',
    '',
    `Base URL: ${BASE_URL}`,
    `API key file: ${keyFile}`,
    '',
    'Cursor Settings -> Models:',
    '1. Enable/add your OpenAI API key.',
    '2. Enable Override OpenAI Base URL.',
    `3. Set the override URL to ${BASE_URL}.`,
    '4. Use Chat/Agent only; Cursor Tab/autocomplete remains on Cursor infrastructure.',
    '',
    'Important: Cursor currently applies the OpenAI Base URL override globally to OpenAI-family model requests.',
    'Disable the override before switching back to Cursor-managed OpenAI-family models.',
    '',
  ].join('\n'))
  writeState('cursor', {
    target: 'cursor',
    files: [{ path, ...backup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out('Cursor guided setup profile dibuat.')
  deps.out(`Panduan: ${path}`)
  deps.out(t('BCCLI does not edit Cursor’s internal storage because that override format is not a stable external configuration.'))
}


function agentToolDefaultModel(models: string[]): string {
  for (const id of ['ling-3.0-flash', 'mimo-v2.5', 'deepseek-v4-flash']) {
    if (models.includes(id)) return id
  }
  const first = models[0]
  if (!first) throw new ConfigError(t('The BotConnector catalog has no model for external coding agents.'))
  return first
}

async function connectCodex(deps: IntegrationDeps): Promise<void> {
  if (readState('codex', deps.env)) disconnect('codex', deps)

  const home = homeDir(deps.env)
  const codexHome = deps.env.CODEX_HOME || join(home, '.codex')
  const profilePath = join(codexHome, 'botconnector.config.toml')
  const launcher = join(integrationHome(deps.env), process.platform === 'win32' ? 'codex-botconnector.cmd' : 'codex-botconnector')
  if (existsSync(profilePath)) {
    throw new ConfigError(t('Codex already has botconnector.config.toml. BCCLI will not overwrite it.'))
  }
  const profileBackup = safeBackup(profilePath, deps.env)
  const launcherBackup = safeBackup(launcher, deps.env)
  const secret = ensureSecret(deps.env)
  const models = await botConnectorModels(deps)
  const model = agentToolDefaultModel(models)

  const profile = [
    `model = ${JSON.stringify(model)}`,
    'model_provider = "botconnector"',
    '',
    '[model_providers.botconnector]',
    'name = "BotConnector"',
    `base_url = "${BASE_URL}"`,
    'env_key = "BOTCONNECTOR_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'supports_standalone_web_search = false',
    '',
  ].join('\n')
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(profilePath, profile)

  mkdirSync(dirname(launcher), { recursive: true })
  if (process.platform === 'win32') {
    const keyFile = secret.replace(/\//g, '\\')
    writeFileSync(launcher, [
      '@echo off',
      'set "BOTCONNECTOR_API_KEY="',
      `for /f "usebackq delims=" %%A in ("${keyFile}") do set "BOTCONNECTOR_API_KEY=%%A"`,
      'codex -p botconnector %*',
      '',
    ].join('\r\n'))
  } else {
    const keyFile = secret.replace(/'/g, "'\\''")
    writeFileSync(launcher, [
      '#!/bin/sh',
      `export BOTCONNECTOR_API_KEY="$(cat '${keyFile}')"`,
      'exec codex -p botconnector "$@"',
      '',
    ].join('\n'), { mode: 0o700 })
    try { chmodSync(launcher, 0o700) } catch {}
  }

  writeState('codex', {
    target:'codex',
    files:[{ path:profilePath, ...profileBackup }, { path:launcher, ...launcherBackup }],
    createdAt:new Date().toISOString(),
  }, deps.env)
  deps.out(t('Codex CLI is connected to the BotConnector Responses API.'))
  deps.out(`Profile: ${profilePath}`)
  deps.out(`Launcher: ${launcher}`)
  deps.out(`Default coding model: ${model}`)
}

async function connectClaudeCode(deps: IntegrationDeps): Promise<void> {
  const secret = ensureSecret(deps.env)
  const models = await botConnectorModels(deps)
  const model = agentToolDefaultModel(models)
  const launcher = join(integrationHome(deps.env), process.platform === 'win32' ? 'claude-botconnector.cmd' : 'claude-botconnector')
  const backup = safeBackup(launcher, deps.env)
  mkdirSync(dirname(launcher), { recursive: true })

  if (process.platform === 'win32') {
    const keyFile = secret.replace(/\//g, '\\')
    writeFileSync(launcher, [
      '@echo off',
      'set "ANTHROPIC_AUTH_TOKEN="',
      'set "CLAUDE_CODE_OAUTH_TOKEN="',
      'set "ANTHROPIC_API_KEY="',
      `for /f "usebackq delims=" %%A in ("${keyFile}") do set "ANTHROPIC_API_KEY=%%A"`,
      'set "ANTHROPIC_BASE_URL=https://api.botconnector.id"',
      `set "ANTHROPIC_MODEL=${model}"`,
      `set "ANTHROPIC_DEFAULT_OPUS_MODEL=${model}"`,
      `set "ANTHROPIC_DEFAULT_SONNET_MODEL=${model}"`,
      `set "ANTHROPIC_DEFAULT_HAIKU_MODEL=${model}"`,
      'claude %*',
      '',
    ].join('\r\n'))
  } else {
    const keyFile = secret.replace(/'/g, "'\\''")
    writeFileSync(launcher, [
      '#!/bin/sh',
      'unset ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN',
      `export ANTHROPIC_API_KEY="$(cat '${keyFile}')"`,
      "export ANTHROPIC_BASE_URL='https://api.botconnector.id'",
      `export ANTHROPIC_MODEL='${model}'`,
      `export ANTHROPIC_DEFAULT_OPUS_MODEL='${model}'`,
      `export ANTHROPIC_DEFAULT_SONNET_MODEL='${model}'`,
      `export ANTHROPIC_DEFAULT_HAIKU_MODEL='${model}'`,
      'exec claude "$@"',
      '',
    ].join('\n'), { mode:0o700 })
    try { chmodSync(launcher, 0o700) } catch {}
  }

  writeState('claude-code', {
    target:'claude-code',
    files:[{ path:launcher, ...backup }],
    createdAt:new Date().toISOString(),
  }, deps.env)
  deps.out(t('Claude Code is connected to the BotConnector Anthropic Messages compatibility API.'))
  deps.out(`Launcher: ${launcher}`)
  deps.out(`Default coding model: ${model}`)
}

type OpenClawSecretRef = { source: 'env'; provider: string; id: string }

/**
 * OpenClaw >= 2026.9.x: custom providers live under models.providers.<id>
 * and MUST declare a models array (custom providers without models are
 * rejected). The API key is stored as an env SecretRef — never plaintext.
 * The model list mirrors the live catalog; no contextWindow/maxTokens
 * guesses are written (OpenClaw keeps its own runtime metadata).
 */
async function connectOpenClaw(deps: IntegrationDeps): Promise<void> {
  const home = homeDir(deps.env)
  const clawHome = deps.env.OPENCLAW_CONFIG_DIR || join(home, '.openclaw')
  const path = join(clawHome, 'openclaw.json')
  const backup = safeBackup(path, deps.env)
  ensureSecret(deps.env)
  const models = await botConnectorModels(deps)
  const model = externalAgentDefaultModel(models, deps)

  let doc: Record<string, unknown> = {}
  if (existsSync(path)) {
    try { doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> }
    catch { throw new ConfigError(t('The OpenClaw config is not valid JSON: {path}', { path })) }
  }
  const modelsRoot = (doc.models && typeof doc.models === 'object' && !Array.isArray(doc.models))
    ? { ...(doc.models as Record<string, unknown>) }
    : {}
  const providers = (modelsRoot.providers && typeof modelsRoot.providers === 'object' && !Array.isArray(modelsRoot.providers))
    ? { ...(modelsRoot.providers as Record<string, unknown>) }
    : {}
  const existing = providers[PROVIDER_ID] as { baseUrl?: string; models?: unknown[] } | undefined
  if (existing?.baseUrl && existing.baseUrl.replace(/\/+$/, '') !== BASE_URL) {
    throw new ConfigError(t('OpenClaw already has a provider "{id}" with a different endpoint ({base}). BCCLI will not overwrite it; disconnect or change that provider first.', { id: PROVIDER_ID, base: existing.baseUrl }))
  }

  const secretRef: OpenClawSecretRef = { source: 'env', provider: PROVIDER_ID, id: OPENCLAW_ENV_ID }
  providers[PROVIDER_ID] = {
    baseUrl: BASE_URL,
    api: 'openai-completions',
    apiKey: secretRef,
    // Live catalog ids only; OpenClaw resolves provider capabilities itself.
    models: models.map((id) => ({ id, name: id })),
  }
  modelsRoot.providers = providers
  doc.models = modelsRoot

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`)
  writeState('openclaw', {
    target: 'openclaw',
    files: [{ path, ...backup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out(t('OpenClaw is connected to BotConnector ({n} models; default {model}).', { n: models.length, model }))
  deps.out(`Config: ${path}`)
  deps.out(t('API key: env {env} (SecretRef, not stored in the config).', { env: OPENCLAW_ENV_ID }))
  deps.out(t('Set the default model in OpenClaw with: openclaw models set {provider}/{model}', { provider: PROVIDER_ID, model }))
}

/**
 * Hermes Agent (Nous Research): custom providers declare `api`, `key_env`,
 * and `transport: chat_completions`. `discover_models: true` lets Hermes
 * resolve the live catalog itself, so BCCLI writes no model list and no
 * context lengths. The key stays in the process env / Hermes .env — never
 * inside config.yaml. Existing config entries and other providers are kept.
 */
async function connectHermes(deps: IntegrationDeps): Promise<void> {
  const home = homeDir(deps.env)
  const hermesHome = deps.env.HERMES_HOME || join(home, '.hermes')
  const path = join(hermesHome, 'config.yaml')
  const backup = safeBackup(path, deps.env)
  ensureSecret(deps.env)
  const models = await botConnectorModels(deps)
  const model = externalAgentDefaultModel(models, deps)

  const source = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const doc = parseDocument(source)
  if (doc.errors.length) throw new ConfigError(t('The Hermes config is not valid YAML: {path}', { path }))

  const previousProvider = doc.getIn(['providers', HERMES_PROVIDER_ID]) as { api?: string } | undefined
  if (previousProvider?.api && previousProvider.api.replace(/\/+$/, '') !== BASE_URL) {
    throw new ConfigError(t('Hermes already has a provider "{id}" with a different endpoint ({base}). BCCLI will not overwrite it; disconnect or change that provider first.', { id: HERMES_PROVIDER_ID, base: previousProvider.api }))
  }

  doc.setIn(['providers', HERMES_PROVIDER_ID], {
    api: BASE_URL,
    key_env: HERMES_ENV_ID,
    transport: 'chat_completions',
    default_model: model,
    discover_models: true,
    models: Object.fromEntries(models.map((id) => [id, {}])),
  })
  doc.setIn(['model'], { default: model, provider: `custom:${HERMES_PROVIDER_ID}` })

  mkdirSync(hermesHome, { recursive: true })
  writeFileSync(path, doc.toString())
  writeState('hermes', {
    target: 'hermes',
    files: [{ path, ...backup }],
    createdAt: new Date().toISOString(),
  }, deps.env)
  deps.out(t('Hermes is connected to BotConnector ({n} models; default {model}).', { n: models.length, model }))
  deps.out(`Config: ${path}`)
  deps.out(t('API key: env {env} only (via key_env; a plaintext key in config.yaml is never written).', { env: HERMES_ENV_ID }))
}

function disconnect(target: IntegrationTarget, deps: IntegrationDeps): void {
  const state = readState(target, deps.env)
  if (!state) {
    deps.out(t('{target}: not managed by BCCLI yet.', { target }))
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
  deps.out(t('{target}: the BotConnector integration was removed and the config restored.', { target }))
}

function listIntegrations(deps: IntegrationDeps): void {
  for (const target of ['opencode', 'aider', 'cline', 'deepseek-harness', 'cursor', 'openai-cli', 'openai-sdk', 'openai-compatible', 'codex', 'claude-code', 'openclaw', 'hermes'] as const) {
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
  else if (target === 'deepseek-harness') await connectDeepSeekHarness(deps)
  else if (target === 'cursor') await connectCursor(deps)
  else if (target === 'openai-cli') await connectOpenAiCli(deps)
  else if (target === 'openai-sdk') await connectOpenAiSdk(deps)
  else if (target === 'openai-compatible') await connectOpenAiCompatible(deps)
  else if (target === 'codex') await connectCodex(deps)
  else if (target === 'openclaw') await connectOpenClaw(deps)
  else if (target === 'hermes') await connectHermes(deps)
  else await connectClaudeCode(deps)
  return 0
}
