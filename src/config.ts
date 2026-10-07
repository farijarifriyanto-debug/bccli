import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PRESETS } from './presets'
import type { ReasoningLevel } from './reasoning'
import type { HooksConfig } from './hooks'
import { DEFAULT_KEYBINDS, KEYBIND_ACTIONS, defaultKeybinds, type Keybind, type KeybindAction, parseKeybind } from './keybinds'
import type { UsageCap } from './budget'
import { t } from './i18n'
import type { Lang } from './i18n'

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'allowAll'

export interface ProviderConfig {
  baseURL: string
  apiKeyEnv?: string
  name?: string
}

export interface Config {
  model: string
  permissionMode: PermissionMode
  reasoning: ReasoningLevel
  /** Tool-call step cap per turn. Omitted (unset) uses DEFAULT_MAX_STEPS; null or 0 means unlimited. */
  maxSteps?: number | null
  /** Interface language; only the global config is read for it. */
  language?: Lang
  /** Tool/session hooks; only the global config is read — the project file is untrusted and must never execute code. */
  hooks?: HooksConfig
  /** Attach images read from disk as vision parts. Only the global config is read; default true. */
  vision?: boolean
  /** Bash network gate: "offline" blocks known internet commands. Only the global config is read. */
  networkPolicy?: 'allow' | 'offline'
  /** JS plugin specs, loaded at boot. Only the global config is read — the project file must never execute code. */
  plugins?: string[]
  /** Resolved TUI key bindings; only the global config is read (a cloned project must not rebind your keys). */
  keybinds: Record<KeybindAction, Keybind>
  /** Commands run after a turn that edited files (aider --test-cmd style). Only the global config is read. */
  verifyCommands: string[]
  /** Per-session token/USD budget; the agent stops calling the model once it is exceeded. Only the global config is read. */
  usageCap?: UsageCap
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

/**
 * Default cap on tool-call steps per turn for the main agent. Interactive CLIs
 * (Claude Code, Codex) leave the main loop unbounded by default, but an uncapped
 * loop can run away on a bad prompt; a generous safety net with the existing
 * "type continue" notice keeps long tasks possible and cost bounded. Set
 * maxSteps to 0/null in the config to restore unlimited.
 */
export const DEFAULT_MAX_STEPS = 100

const DEFAULT_CONFIG: Config = {
  model: 'bc-cloud/glm-5.3-flash',
  permissionMode: 'default',
  reasoning: 'auto',
  vision: true,
  networkPolicy: 'allow',
  keybinds: defaultKeybinds(),
  verifyCommands: [],
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
    throw new ConfigError(t('Invalid config: {path} ({error})', { path, error: (error as Error).message }))
  }
}

/**
 * The project file comes from whatever repo the user cloned, so it is untrusted: it may pick the
 * model and add providers without a key, but it cannot grant permissions, override known providers,
 * bind an env key, or touch the cost guard — so maxSteps is read from the global config only.
 */
function resolvedMaxSteps(global: Partial<Config>): number | null {
  const value = global.maxSteps
  if (value === undefined) return DEFAULT_MAX_STEPS
  if (value === null || value === 0) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(t('maxSteps must be a positive number, or 0/null to disable the limit.'))
  }
  return Math.max(1, Math.floor(value))
}

function resolvedNetworkPolicy(global: Partial<Config>): 'allow' | 'offline' {
  const value = global.networkPolicy ?? 'allow'
  if (value !== 'allow' && value !== 'offline') {
    throw new ConfigError(t('networkPolicy must be "allow" or "offline".'))
  }
  return value
}

function resolvedPlugins(global: Partial<Config>): string[] {
  const value = global.plugins
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(t('plugins must be an array of strings.'))
  }
  return [...(value as string[])]
}

function resolvedUsageCap(global: Partial<Config>): UsageCap | undefined {
  const cap = global.usageCap
  if (cap === undefined) return undefined
  if (typeof cap !== 'object' || cap === null || Array.isArray(cap)) {
    throw new ConfigError(t('usageCap must be an object, e.g. { "tokens": 2000000 }.'))
  }
  const { tokens, usd, prices } = cap as UsageCap
  const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0
  const nonNegative = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (tokens !== undefined && !positive(tokens)) throw new ConfigError(t('usageCap.tokens must be a number greater than 0.'))
  if (usd !== undefined && !positive(usd)) throw new ConfigError(t('usageCap.usd must be a number greater than 0.'))
  if (usd !== undefined && (prices === undefined || !Object.keys(prices).length)) {
    throw new ConfigError(t('usageCap.usd requires usageCap.prices (USD per 1M tokens).'))
  }
  if (prices !== undefined) {
    for (const [key, price] of Object.entries(prices)) {
      if (!price || !nonNegative(price.input) || !nonNegative(price.output)) {
        throw new ConfigError(t('usageCap.prices["{key}"] must have numeric input and output (USD per 1M tokens).', { key }))
      }
    }
  }
  if (tokens === undefined && usd === undefined) throw new ConfigError(t('usageCap needs at least one of: tokens, usd.'))
  return { ...(tokens !== undefined ? { tokens } : {}), ...(usd !== undefined ? { usd } : {}), ...(prices !== undefined ? { prices } : {}) }
}

function resolvedVerifyCommands(global: Partial<Config>): string[] {
  const value = global.verifyCommands
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((c) => typeof c !== 'string' || !c.trim())) {
    throw new ConfigError(t('verifyCommands must be an array of non-empty strings.'))
  }
  return (value as string[]).map((c) => c.trim())
}

function resolvedKeybinds(global: Partial<Config>): Record<KeybindAction, Keybind> {
  const raw = global.keybinds ?? {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(t('keybinds must be an object mapping action to binding.'))
  }
  const out = {} as Record<KeybindAction, Keybind>
  for (const action of KEYBIND_ACTIONS) {
    const spec = (raw as Record<string, unknown>)[action]
    const value = spec === undefined ? DEFAULT_KEYBINDS[action] : spec
    if (typeof value !== 'string') {
      throw new ConfigError(t('Keybind for "{action}" must be a string like "ctrl+t".', { action }))
    }
    const parsed = parseKeybind(value)
    if (!parsed) {
      throw new ConfigError(t('Keybind "{spec}" for "{action}" is invalid: use ctrl or alt plus one letter, e.g. "ctrl+t".', { spec: value, action }))
    }
    out[action] = parsed
  }
  for (const key of Object.keys(raw as object)) {
    if (!KEYBIND_ACTIONS.includes(key as KeybindAction)) {
      throw new ConfigError(t('Unknown keybind action "{action}". Known actions: {list}.', { action: key, list: KEYBIND_ACTIONS.join(', ') }))
    }
  }
  return out
}

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
    reasoning: global.reasoning ?? DEFAULT_CONFIG.reasoning,
    maxSteps: resolvedMaxSteps(global),
    hooks: global.hooks,
    vision: global.vision ?? DEFAULT_CONFIG.vision,
    networkPolicy: resolvedNetworkPolicy(global),
    plugins: resolvedPlugins(global),
    keybinds: resolvedKeybinds(global),
    verifyCommands: resolvedVerifyCommands(global),
    usageCap: resolvedUsageCap(global),
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
    throw new ConfigError(t('Model must be in provider/model format, e.g. bc-cloud/glm-5.3-flash (got: {ref})', { ref: modelRef }))
  }
  const providerId = modelRef.slice(0, slash)
  const provider = config.providers[providerId]
  if (!provider) {
    throw new ConfigError(t('Provider "{id}" is not in the config. Available: {list}', { id: providerId, list: Object.keys(config.providers).join(', ') }))
  }
  const apiKey = (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined) || readCredentials(env)[providerId] || undefined
  if (provider.apiKeyEnv && !apiKey) {
    throw new ConfigError(t('No API key for {id} yet. Run `bccli login` or set the env var {env}.', { id: providerId, env: provider.apiKeyEnv }))
  }
  return { providerId, model: modelRef.slice(slash + 1), baseURL: provider.baseURL.replace(/\/+$/, ''), apiKey }
}

/** Returns false when there was no stored key to remove. */
export function removeCredential(providerId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const creds = readCredentials(env)
  if (!(providerId in creds)) return false
  delete creds[providerId]
  const path = join(bccliHome(env), 'credentials')
  writeFileSync(path, JSON.stringify(creds, null, 2), { mode: 0o600 })
  chmodSync(path, 0o600)
  return true
}
