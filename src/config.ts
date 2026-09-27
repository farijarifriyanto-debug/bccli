import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PRESETS } from './presets'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'allowAll'

export interface ProviderConfig {
  baseURL: string
  apiKeyEnv?: string
  name?: string
}

export interface Config {
  model: string
  permissionMode: PermissionMode
  providers: Record<string, ProviderConfig>
  allow: string[]
  /** Provider ids that came from the (untrusted) project config. */
  projectProviders?: string[]
}

export interface ResolvedModel {
  providerId: string
  model: string
  baseURL: string
  apiKey?: string
}

export class ConfigError extends Error {}

const DEFAULT_CONFIG: Config = {
  model: 'bc-cloud/glm-5.3-flash',
  permissionMode: 'default',
  providers: Object.fromEntries(PRESETS.map((p) => [p.id, { baseURL: p.baseURL, apiKeyEnv: p.apiKeyEnv }])),
  allow: [],
}

export function bccliHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.BCCLI_HOME ?? join(homedir(), '.bccli')
}

export function readJsonConfig(path: string): Partial<Config> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ConfigError(`Config tidak valid: ${path} (${(error as Error).message})`)
  }
}

/**
 * The project file comes from whatever repo the user cloned, so it is untrusted: it may pick the model and
 * add providers without a key, but it cannot grant permissions, override known providers, or bind an env key.
 */
function untrustedProviders(project: Partial<Config>, known: Record<string, ProviderConfig>): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = {}
  for (const [id, provider] of Object.entries(project.providers ?? {})) {
    if (known[id] || typeof provider?.baseURL !== 'string') continue
    out[id] = { baseURL: provider.baseURL }
  }
  return out
}

export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Config {
  const global = readJsonConfig(join(bccliHome(env), 'config.json'))
  const project = readJsonConfig(join(cwd, '.bccli', 'config.json'))
  const known = { ...DEFAULT_CONFIG.providers, ...global.providers }
  const fromProject = untrustedProviders(project, known)
  return {
    model: project.model ?? global.model ?? DEFAULT_CONFIG.model,
    permissionMode: global.permissionMode ?? DEFAULT_CONFIG.permissionMode,
    providers: { ...known, ...fromProject },
    projectProviders: Object.keys(fromProject),
    allow: [...(global.allow ?? [])],
  }
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = join(bccliHome(env), 'credentials')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export function saveCredential(providerId: string, key: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = bccliHome(env)
  mkdirSync(home, { recursive: true })
  const path = join(home, 'credentials')
  writeFileSync(path, JSON.stringify({ ...readCredentials(env), [providerId]: key }, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function resolveModel(config: Config, modelRef: string, env: NodeJS.ProcessEnv = process.env): ResolvedModel {
  const slash = modelRef.indexOf('/')
  if (slash <= 0 || slash === modelRef.length - 1) {
    throw new ConfigError(`Model harus berformat provider/model, contoh bc-cloud/glm-5.3-flash (dapat: ${modelRef})`)
  }
  const providerId = modelRef.slice(0, slash)
  const provider = config.providers[providerId]
  if (!provider) {
    throw new ConfigError(`Provider "${providerId}" tidak ada di config. Tersedia: ${Object.keys(config.providers).join(', ')}`)
  }
  const apiKey = (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined) || readCredentials(env)[providerId] || undefined
  if (provider.apiKeyEnv && !apiKey) {
    throw new ConfigError(`API key untuk ${providerId} belum ada. Jalankan \`bccli login\` atau set env ${provider.apiKeyEnv}.`)
  }
  return { providerId, model: modelRef.slice(slash + 1), baseURL: provider.baseURL.replace(/\/+$/, ''), apiKey }
}

export function removeCredential(providerId: string, env: NodeJS.ProcessEnv = process.env): void {
  const creds = readCredentials(env)
  if (!(providerId in creds)) return
  delete creds[providerId]
  const path = join(bccliHome(env), 'credentials')
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
}
