import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PRESETS } from './presets'
import type { ReasoningLevel } from './reasoning'
import type { HooksConfig } from './hooks'
import { DEFAULT_KEYBINDS, KEYBIND_ACTIONS, defaultKeybinds, type Keybind, type KeybindAction, parseKeybind } from './keybinds'
import { THEMES } from './ui/theme'
import type { LspServer } from './lsp'
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
  /** Optional list of fallback model refs tried in order on 429 / 5xx / connection errors. */
  fallbackModels?: string[]
  permissionMode: PermissionMode
  reasoning: ReasoningLevel
  /** Show provider-supplied reasoning summaries in the TUI. Global setting only. */
  thinkingVisible?: boolean
  /** Delete saved sessions older than this many days at startup. Omitted, null or 0 keeps them until you delete them (the default). Global setting only. */
  sessionRetentionDays?: number | null
  /** Click the Thinking block to expand/collapse it. Off by default: it needs terminal mouse reporting, which blocks drag-to-copy. Global setting only; ctrl+t works either way. */
  thinkingClickCollapse?: boolean
  /** Tool-call step cap per turn. Omitted, null or 0 means unlimited (the default); a positive number opts into a cap. */
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
  /** Daily npm registry check with a notice when a newer bccli exists. Only the global config is read; default "on". */
  updateCheck?: 'on' | 'off'
  /** Include a repo map (files + top-level symbols) in the system prompt. Only the global config is read; default false. */
  repoMap: boolean
  /** Color theme name. Only the global config is read; default "default". */
  theme: string
  /** Prompt editing style. Only the global config is read; default "emacs". */
  editor: 'emacs' | 'vim'
  /** Run bash commands inside the OS sandbox (macOS sandbox-exec / Linux bwrap). Only the global config is read; default "off". */
  sandbox: 'off' | 'on'
  /** LSP servers used by the diagnostics tool. Only the global config is read (it spawns commands). */
  lsp?: { servers: LspServer[] }
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
 * Default cap on tool-call steps per turn for the main agent: none, like Claude Code, Codex and
 * OpenCode (its `steps` is unset = unlimited). The turn runs until the model stops or the user
 * presses Esc. Set maxSteps in the global config to a positive number to opt into a safety cap
 * (the "type continue" notice then appears when it is reached).
 */
export const DEFAULT_MAX_STEPS: number | null = null

const DEFAULT_CONFIG: Config = {
  model: 'bc-cloud/glm-5.3-flash',
  permissionMode: 'default',
  reasoning: 'auto',
  vision: true,
  networkPolicy: 'allow',
  keybinds: defaultKeybinds(),
  verifyCommands: [],
  repoMap: false,
  theme: 'default',
  editor: 'emacs',
  sandbox: 'off',
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

function resolvedSessionRetentionDays(global: Partial<Config>): number | null {
  const value = global.sessionRetentionDays
  if (value === undefined || value === null || value === 0) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(t('sessionRetentionDays must be a positive number of days, or 0/null to keep sessions.'))
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

function resolvedUpdateCheck(global: Partial<Config>): 'on' | 'off' | undefined {
  const value = global.updateCheck
  if (value === undefined) return undefined
  if (value !== 'on' && value !== 'off') throw new ConfigError(t('updateCheck must be "on" or "off".'))
  return value
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

function resolvedLsp(global: Partial<Config>): { servers: LspServer[] } | undefined {
  if (global.lsp === undefined) return undefined
  const lsp = global.lsp as { servers?: unknown }
  if (typeof global.lsp !== 'object' || global.lsp === null || !Array.isArray(lsp.servers)) {
    throw new ConfigError(t('lsp must be an object with a "servers" array.'))
  }
  for (const s of lsp.servers as unknown[]) {
    const server = s as Partial<LspServer>
    if (
      typeof server?.command !== 'string' ||
      !server.command ||
      !Array.isArray(server.extensions) ||
      server.extensions.length === 0 ||
      server.extensions.some((e) => typeof e !== 'string' || !e.startsWith('.')) ||
      (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((a) => typeof a !== 'string')))
    ) {
      throw new ConfigError(t('Each lsp server needs { "extensions": [".ts"], "command": "...", "args": ["..."] }.'))
    }
  }
  return { servers: lsp.servers as LspServer[] }
}

function resolvedSandbox(global: Partial<Config>): 'off' | 'on' {
  const value = global.sandbox ?? 'off'
  if (value !== 'off' && value !== 'on') throw new ConfigError(t('sandbox must be "off" or "on".'))
  return value
}

function resolvedEditor(global: Partial<Config>): 'emacs' | 'vim' {
  const value = global.editor ?? 'emacs'
  if (value !== 'emacs' && value !== 'vim') throw new ConfigError(t('editor must be "emacs" or "vim".'))
  return value
}

function resolvedTheme(global: Partial<Config>): string {
  const value = global.theme ?? 'default'
  if (typeof value !== 'string' || !(THEMES as readonly string[]).includes(value)) {
    throw new ConfigError(t('theme must be one of: {themes}.', { themes: THEMES.join(', ') }))
  }
  return value
}

function resolvedRepoMap(global: Partial<Config>): boolean {
  const value = global.repoMap ?? false
  if (typeof value !== 'boolean') throw new ConfigError(t('repoMap must be true or false.'))
  return value
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
  const rawFallbacks = project.fallbackModels ?? global.fallbackModels
  const fallbackModels = Array.isArray(rawFallbacks)
    ? rawFallbacks.filter((m): m is string => typeof m === 'string' && m.includes('/'))
    : undefined
  return {
    model: project.model ?? global.model ?? DEFAULT_CONFIG.model,
    ...(fallbackModels?.length ? { fallbackModels } : {}),
    permissionMode: global.permissionMode ?? DEFAULT_CONFIG.permissionMode,
    reasoning: global.reasoning ?? DEFAULT_CONFIG.reasoning,
    thinkingVisible: global.thinkingVisible === true,
    thinkingClickCollapse: global.thinkingClickCollapse === true,
    sessionRetentionDays: resolvedSessionRetentionDays(global),
    maxSteps: resolvedMaxSteps(global),
    hooks: global.hooks,
    vision: global.vision ?? DEFAULT_CONFIG.vision,
    networkPolicy: resolvedNetworkPolicy(global),
    plugins: resolvedPlugins(global),
    keybinds: resolvedKeybinds(global),
    verifyCommands: resolvedVerifyCommands(global),
    repoMap: resolvedRepoMap(global),
    theme: resolvedTheme(global),
    editor: resolvedEditor(global),
    sandbox: resolvedSandbox(global),
    lsp: resolvedLsp(global),
    usageCap: resolvedUsageCap(global),
    updateCheck: resolvedUpdateCheck(global),
    providers: { ...known, ...fromProject },
    projectProviders: Object.keys(fromProject),
    allow: [...(global.allow ?? [])],
  }
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(bccliHome(env), 'config.json')
}

export function readGlobalPlugins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = readJsonConfig(globalConfigPath(env)) as { plugins?: unknown }
  const value = raw.plugins
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError(t('plugins must be an array of strings.'))
  }
  return value as string[]
}

export function writeFileAtomic(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, data, mode === undefined ? undefined : { mode })
    renameSync(tmp, path)
    if (mode !== undefined) chmodSync(path, mode)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // best-effort cleanup — the original error is what matters
    }
    throw error
  }
}

/**
 * A corrupt JSON file must never be silently treated as empty: the next write would
 * wipe whatever the user had. Move it aside in place (timestamped, same folder) so
 * the data stays recoverable, and warn on stderr. Returns the backup path.
 */
export function quarantineCorruptFile(path: string, error: unknown): string | undefined {
  const stamp = Date.now()
  let dest = `${path}.corrupt-${stamp}`
  for (let n = 1; existsSync(dest); n++) dest = `${path}.corrupt-${stamp}-${n}`
  try {
    renameSync(path, dest)
  } catch {
    return undefined
  }
  console.error(`${path} is not valid JSON (${(error as Error).message}); moved it to ${dest} instead of overwriting it.`)
  return dest
}

/**
 * Read-modify-write of the global config.json. `mutate` throwing aborts before
 * any write; the write itself is atomic (tmp + rename in the same directory),
 * so a failed run never leaves a truncated or half-updated config.
 */
export function updateGlobalConfig(env: NodeJS.ProcessEnv, mutate: (cfg: Record<string, unknown>) => void): void {
  const path = globalConfigPath(env)
  let cfg: Record<string, unknown> = {}
  if (existsSync(path)) {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  }
  mutate(cfg)
  mkdirSync(dirname(path), { recursive: true })
  writeFileAtomic(path, `${JSON.stringify(cfg, null, 2)}\n`)
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = join(bccliHome(env), 'credentials')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // Never start from {} silently: the next save would drop every key in the file.
    quarantineCorruptFile(path, error)
    return {}
  }
}

export function saveCredential(providerId: string, key: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = bccliHome(env)
  mkdirSync(home, { recursive: true })
  writeFileAtomic(join(home, 'credentials'), JSON.stringify({ ...readCredentials(env), [providerId]: key }, null, 2), 0o600)
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
  // A key the user saved in the app (`bccli login`) wins over an inherited env var; the env var is the fallback.
  const apiKey = readCredentials(env)[providerId] || (provider.apiKeyEnv ? env[provider.apiKeyEnv] : undefined) || undefined
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
  writeFileAtomic(join(bccliHome(env), 'credentials'), JSON.stringify(creds, null, 2), 0o600)
  return true
}
