import { parseArgs } from 'node:util'
import { ConfigError, type PermissionMode } from './config'
import { MODE_ORDER } from './permissions'
import { isReasoningLevel, REASONING_LEVELS, type ReasoningLevel } from './reasoning'
import { LOOPBACK_BIND } from './serveProtocol'
import { type Lang, parseLang, t } from './i18n'

export interface CliArgs {
  command: 'run' | 'login' | 'models' | 'update' | 'acp' | 'serve' | 'plugins' | 'gh-bot' | 'provider' | 'mcp' | 'connect' | 'disconnect' | 'integrations' | 'completion' | 'stats' | 'export' | 'import' | 'pr'
  subArgs: string[]
  url?: string
  name?: string
  keyEnv?: string
  values: string[]
  prompt?: string
  print: boolean
  model?: string
  reasoning?: ReasoningLevel
  lang?: Lang
  continue: boolean
  resume: boolean
  allowAll: boolean
  allowedTools: string[]
  worktree?: string
  outputFormat?: 'text' | 'json' | 'stream-json'
  permissionMode?: PermissionMode
  help: boolean
  version: boolean
  loginProvider?: string
  /** `bccli login` — pakai prompt API key lama, bukan OAuth. */
  key: boolean
  /** `bccli login` — hapus credential tersimpan (hanya openrouter via OAuth path). */
  logout: boolean
  /** `bccli serve` listener port (0 = ephemeral). */
  port?: number
  /** `bccli serve` bind address — loopback only. */
  host?: string
  /** `bccli serve` bearer token override. */
  token?: string
  /** Base URL override for `bccli mcp serve`. */
  baseUrl?: string
  /** `bccli stats` — only count sessions from the last N days (default 7). */
  days?: number
  /** `bccli stats` - cap the tool-usage list to the top N tools. */
  tools?: number
  /** `bccli stats [--models [N|all]]` - show per-model token usage (top N or all). */
  models?: string
  /** `bccli stats --project <slug>` - filter rows; empty string = current project. */
  project?: string
  /** `bccli pr` — explicit owner/name repo when cwd is not a git checkout of the PR. */
  repo?: string
  /** Automatic fallback model ref when the primary model fails with 429 or 5xx. */
  fallbackModel?: string
}

const HELP = `BCCLI — BotConnector's AI coding agent for the terminal

Usage:
  bccli [task]                  interactive mode (optionally start with a task)
  bccli -p "task"               run one task without interaction (scripts/CI)
  bccli login [provider]        OAuth login (or --key paste API key, --logout remove)
  bccli models [provider]       list models (default: the active provider)
  bccli update                  install the newest bccli from npm
  bccli acp                     run as an ACP agent for editors (Zed, ...)
  bccli serve [--port N]        serve sessions over HTTP+WS for IDEs/bots
  bccli plugins               list, install, remove, or update plugins
  bccli gh-bot [serve]         GitHub comment bot (off-by-default; needs config)
  bccli provider list|add <id>|remove <id>   manage providers (custom: --url <url> [--name N] [--key-env ENV])
  bccli mcp list|add <name>|remove <name>|auth <name>|logout <name>|serve [--base-url <url>]    manage MCP servers, or serve this account's tools over stdio
  bccli completion <shell>     print a shell completion script (bash, zsh, fish, powershell)
  bccli stats [--days N] [--tools N] [--models [N|all]] [--project slug]
                                     show token usage from local sessions (default: last 7 days)
  bccli export [session] [file]  copy a session JSONL to a file (default: last session here)
  bccli import <file>          import a session JSONL into the current project
  bccli pr <number> [--repo owner/name] [task]   check out a GitHub PR and run a task on it
  bccli integrations             show the status of external agent integrations
  bccli connect <agent>          opencode, aider, cline, dsh, codex, claude-code, cursor, openai-cli, openai-sdk, openai-compatible, openclaw, hermes
  bccli disconnect <agent>       remove an integration and restore the previous config

Options:
  -m, --model <provider/model>  choose a model, e.g. bc-cloud/glm-5.3-flash
      --reasoning <level>        auto | off | low | medium | high | max
  -c, --continue                continue the last session in this folder
  -r, --resume                  pick a session to continue
      --allow-all               run all tools without asking for permission
      --allowed-tools <a,b>     tools allowed without asking: bash, edit, fetch
  -w, --worktree <name>        run in git worktree ../<repo>.worktrees/<name> (created, or reused if it exists)
      --output-format <fmt>     text | json | stream-json for -p (machine-readable output)
      --permission-mode <mode>  default | acceptEdits | plan | allowAll
      --lang <en|id>            interface language (default: en; or BCCLI_LANG, or "language" in config)
  -v, --version                 version
  -h, --help                    this help`

/** Help text in the current language (call it after the language is set). */
export const helpText = (): string => t(HELP)

export function parseCliArgs(argv: string[]): CliArgs {
  // `--models` may appear bare (show all) or with a number; parseArgs string options
  // require a value, so a bare flag is rewritten to `--models=all` before parsing.
  const expanded = argv.map((a, i) => {
    const nextIsFlagOrEnd = i + 1 >= argv.length || argv[i + 1].startsWith('-')
    if (a === '--models' && nextIsFlagOrEnd) return '--models=all'
    if (a === '--project' && nextIsFlagOrEnd) return '--project='
    return a
  })
  const { values, positionals } = parseArgs({
    args: expanded,
    allowPositionals: true,
    options: {
      print: { type: 'boolean', short: 'p' },
      model: { type: 'string', short: 'm' },
      reasoning: { type: 'string' },
      lang: { type: 'string' },
      continue: { type: 'boolean', short: 'c' },
      resume: { type: 'boolean', short: 'r' },
      'allow-all': { type: 'boolean' },
      'allowed-tools': { type: 'string' },
      worktree: { type: 'string', short: 'w' },
      'output-format': { type: 'string' },
      'permission-mode': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      url: { type: 'string' },
      name: { type: 'string' },
      'key-env': { type: 'string' },
      value: { type: 'string', multiple: true },
      key: { type: 'boolean' },
      logout: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      token: { type: 'string' },
      'base-url': { type: 'string' },
      days: { type: 'string' },
      tools: { type: 'string' },
      models: { type: 'string' },
      project: { type: 'string' },
      repo: { type: 'string' },
      'fallback-model': { type: 'string' },
    },
  })
  const reasoning = values.reasoning
  if (reasoning && !isReasoningLevel(reasoning)) {
    throw new ConfigError(t('--reasoning must be one of: {levels}', { levels: REASONING_LEVELS.join(', ') }))
  }
  const mode = values['permission-mode']
  if (mode && !MODE_ORDER.includes(mode as PermissionMode)) {
    throw new ConfigError(t('--permission-mode must be one of: {modes}', { modes: MODE_ORDER.join(', ') }))
  }
  if (values.lang !== undefined && !parseLang(values.lang)) throw new ConfigError(t('--lang must be one of: en, id'))
  const outputFormat = values['output-format']
  if (outputFormat !== undefined && !['text', 'json', 'stream-json'].includes(outputFormat)) {
    throw new ConfigError(t('--output-format must be one of: {formats}', { formats: 'text, json, stream-json' }))
  }
  const [first, ...rest] = positionals
  const SUBCOMMANDS = ['login', 'models', 'update', 'acp', 'serve', 'plugins', 'gh-bot', 'provider', 'mcp', 'connect', 'disconnect', 'integrations', 'completion', 'stats', 'export', 'import', 'pr']
  const command = SUBCOMMANDS.includes(first) ? (first as CliArgs['command']) : 'run'
  const words = command === 'run' ? positionals : rest
  const port = values.port !== undefined ? Number(values.port) : undefined
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new ConfigError(t('--port must be a number between 0 and 65535'))
  }
  const days = values.days !== undefined ? Number(values.days) : undefined
  if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
    throw new ConfigError(t('--days must be a positive integer'))
  }
  const tools = values.tools !== undefined ? Number(values.tools) : undefined
  if (tools !== undefined && (!Number.isInteger(tools) || tools < 1)) {
    throw new ConfigError(t('--tools must be a positive integer'))
  }
  let models: string | undefined
  if (values.models !== undefined) {
    models = values.models === '' || values.models === 'all' ? 'all' : values.models
    if (models !== 'all' && (!Number.isInteger(Number(models)) || Number(models) < 1)) {
      throw new ConfigError(t('--models must be a positive integer or "all"'))
    }
  }
  if (values.host !== undefined && !LOOPBACK_BIND.has(values.host)) {
    throw new ConfigError(t('serve only accepts loopback --host (127.0.0.1, localhost, ::1)'))
  }
  return {
    command,
    prompt: command === 'run' && words.length ? words.join(' ') : undefined,
    print: !!values.print,
    model: values.model,
    reasoning: reasoning as ReasoningLevel | undefined,
    lang: parseLang(values.lang),
    continue: !!values.continue,
    resume: !!values.resume,
    allowAll: !!values['allow-all'],
    allowedTools: (values['allowed-tools'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    worktree: values.worktree,
    outputFormat: outputFormat as CliArgs['outputFormat'],
    permissionMode: mode as PermissionMode | undefined,
    help: !!values.help,
    version: !!values.version,
    loginProvider: command === 'login' ? (rest[0] ?? 'bc-cloud') : undefined,
    key: !!values.key,
    logout: !!values.logout,
    subArgs: ['models', 'plugins', 'gh-bot', 'provider', 'mcp', 'connect', 'disconnect', 'integrations', 'completion', 'stats', 'export', 'import', 'pr'].includes(command) ? rest : [],
    url: values.url,
    name: values.name,
    keyEnv: values['key-env'],
    values: values.value ?? [],
    port,
    host: values.host,
    token: values.token,
    baseUrl: values['base-url'],
    days,
    tools,
    models,
    project: values.project,
    repo: values.repo,
    fallbackModel: values['fallback-model'],
  }
}
